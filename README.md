# cortico-world-shell

Owner: `src/definition.ts`

Cortico World 扩展:执行 [Niubash](https://github.com/unixwin/niubash)(原生 Windows 的 bash)命令,每条命令一个**全新的进程**、跑完即退——没有常驻会话、没有跨调用的状态:`cd` 过的目录、`export` 的变量都随那个进程消失。命令超时或被中断会终止这次调用的进程树。默认**每一轮的第一条命令先在桌面上问使用者同意**(`worlds.shell.ask`,四档,最严可调成每条都问、最松可完全不问)。

装配挂载时本 World 只做一次版本探测(和一次 `rtk` 定位),不常驻任何东西;只有 `shell_run` 被调用才拉起 niu(禁用/未调用时零副作用)。

一句话的取舍:**一条命令就是一套完整的动作**。需要几步并存的中间状态(先编译再跑)就写进同一次 `shell_run`(分号、换行、管道都行),不要指望下一条还记得。

## 工具

| 工具 | 作用 |
|---|---|
| `shell_run` | 在一条全新的 Niubash 进程里执行一条 bash 语句(可多行),回执含 `[ok]`/`[fail]`、`exit`(命令退出码)、`[cwd]`(跑完时的目录)、`[bg]`(跑完后还活着的直接子进程)、stdout、`[stderr]`。按 `worlds.shell.ask` 可能先弹确认框问使用者,没同意就是 `[未执行]` 回执;超时/中断回执是 `[timeout]`/`[interrupted]`,命令让 shell 提前退出是 `[incomplete]`。 |

## 命令怎么交给 niu

`niu -c <script>` 起进程:命令原文 + 一小段收尾语句,作为**一个参数**传给 niu。`niu -c` 不加载 rc、不加载插件,项目文档说这正是外部宿主调用它的安静、确定的方式。几个点:

- 收尾语句先抓 `$?`,紧接着 `set +e`:命令里开的 errexit 不能打断收尾,成功命令不会因为收尾自己的退出状态变成 `[incomplete]`。然后用 `cd -P .` 把 `$PWD` 落成物理路径(rubash 对 `cd /tmp` 这类输入方言是惰性解析的,紧跟 `cd` 读 `$PWD` 可能拿回方言本身),最后列出这条命令的直接子进程。
- 子进程用 `ps -e -o pid,ppid,comm,args --no-headers` 按 `ppid == $$` 过滤(winuxcmd 自带 ps,有 PPID 列);`conhost.exe`(Windows 挂给控制台的宿主)和快照自己的 `ps.exe` 不算它起的。字段用参数展开切,不用 `set --`:命令里跑了 `set -u` 或改过 `IFS` 也不能弄坏收尾。
- 整段脚本是命令行参数:Windows 整条命令行上限 32767 字符,拼出来超过就在启动前直接报错(让它拆短),命令最多 8000 字的工具上限留有余量。
- 多行块、here-doc、管道都没问题(整段 `-c` 一起解析);命令里 `exit`、解析错误、终止性失败会让 shell 跑不到收尾,回执标 `[incomplete]`,只报进程自己的退出码,不伪造状态。

## 先问你(`worlds.shell.ask`)

和电脑操作 World 同一套四档:`ask-each-command`(每条命令都弹框)、`ask-each-turn`(每一轮第一条命令前问一次,默认)、`ask-once`(问一次,同意后 `grantMinutes` 分钟内不再问)、`never-ask`(都不问)。

批准必须落在模型之外,否则它自己就能伪造一句"使用者同意了"。扩展这一层拿不到应用注入给电脑操作 World 的 `askPermission`,所以弹框**照电脑操作 World 的窗口做成同一种原生消息框**:用 koffi 调 `user32!MessageBoxTimeoutW`,系统原生的「是/否」消息框(问号图标、置顶、自动抢到前台),`timeoutMs` 到点自己关闭、按拒绝算;默认按钮是「否」,回车、Esc 都按拒绝算,别在打字时误批。

- 框里显示这次命令的工作目录与程序,以及命令的头 800 字和尾 800 字(超过 1600 字时,中间省略多少字会写明)。控制字符、双向控制符和零宽字符先转义再显示,避免显示顺序和实际执行不一致。
- 弹框跑在 koffi 的工作线程上,等待期间 World 不卡;`ask-each-turn` 和 `ask-once` 下同一轮并行调用共用同一次提问,`ask-each-command` 每条各弹一个。
- 消息框按钮文字是系统写死的,没有「总是允许这条」这个第三按钮——那是上一代自绘窗口才有的东西。免询问名单因此改为**手写维护**(见下)。
- 等待被打断(调用被中断)时按拒绝继续;框本身关不掉,会留到自己的超时,但等待方已经走了,没人能靠它批准什么。
- 确认框起不来(比如 koffi/user32 装载失败)一律按拒绝,并落一条 `确认框没有给出答案,按拒绝处理`(带错误原因),分得清「你点了否」和「框根本没起来」。
- 未获同意时命令**根本没有进任何进程**,回执是 `[未执行] …不要换个写法重试,等使用者开口。`,并落一条 `warn`(含命令前 500 字和答案)。`ask-each-turn`/`ask-once` 下拒绝在本轮内对所有后续命令有效;`ask-each-command` 下一条命令仍会单独问。
- 框架只给可见 World 发 `onTurnEnded`,`setWorldVisible()` 也不重启实例,所以 `ask-each-turn` 下隐藏再显示后,隐藏前那一轮的同意可能还在;`onHandoffEnded()` 会清掉交接前后的同意,这个显示/隐藏缺口要 Core 给隐藏 World 发收尾通知才能补。`ask-once` 的时间窗按设计不受影响。
- 环境提示词里有 `{{shell.ask}}` 说明当前档位;WebUI 有「先问你」徽章,等回答时「在等你点头」灯泡亮着。
- `never-ask` 就是把这道闸整个拆掉,只在信任它的时候用。

## 免询问名单(`allowlist.json`)

`<dataDir>/shell/allowlist.json` 是一个普通 JSON 数组,里面写**整条命令的原文**,命中的命令不再弹框、直接执行(命中落一条 `info` 日志)。

- 名单在 World 启动时读入内存:**运行中改文件不会生效,重启本 World 后生效**。这样一次已经批准的会话里,命令不能靠改这个文件让下一条命令免问。
- 匹配只认整条命令的原文:先去掉首尾空白、统一换行风格,再逐字比对。`git status` 在名单里,`git status -s` 照样要问——多个参数就是另一条命令。没有前缀匹配、没有通配符、也不看程序名。
- 名单**由使用者自己编辑**:弹框是系统原生的,没有能写名单的按钮。文件坏了、不是数组、路径是个目录 → 当作没有名单,该问还是问,不会因为读不了就放行。
- 一句实话:**这不是安全边界。**bot 手里就有一条 shell,它想就能自己写这个文件;启动时快照只是让改动不能在本次运行里即时生效。真要收紧就把 `ask` 调成 `ask-each-command`,环境提示词里也写明了不许它开口要你把它常用的命令加进名单。

## 进程可见性

自动记忆(GitMem)只存 bot 自己写下的文字,不采集任何进程信息;命令一返回,stdout 就没了,而它 `sleep 45 &`、`cmd.exe /c start ...` 起来的东西还在跑——而且因为 shell 跑完即退,那些进程**当场就变成孤儿**。所以「它刚起了什么」必须由回执当面说清:

- 每条命令收尾时顺手查一次自己的直接子进程(见上),写进这次回执的 `[bg] niu(18244)`(`[bg]` 排在 stdout 前,免得被 WebUI 的回执截断挤掉)。快照和命令同一次执行,不多一次往返,实测每条命令多几十毫秒。
- 无状态就没有跨命令的账本:后续命令的回执只反映它自己起的进程;先前的孤儿还在跑,但不再被提及,要看自己 `ps`。`[bg]` 里列出的要停就用回执给的 pid `kill`。
- 边界:只看得见当次 shell 的**直接子进程**。脱离这条链的东西(注册服务、计划任务、父进程已换的孤儿进程)不在快照里;环境提示词把这条边界写在明面上。
- 应用被强杀时,正在跑的那条命令不依赖应用继续喂输入(整段脚本在命令行上),它的 shell 自己跑完就退;命令起的子进程仍是孤儿,该停要停。超时或中断时 runner 用 `taskkill /T /F` 终止整棵进程树,不只是直接子进程;停用/卸载本 World 会 abort 正在跑的那次调用,同样杀掉它的进程树。

## 追踪

每条命令的原文、耗时、回执前 600 字由框架记在 `data/runs/<run>/toolcalls.jsonl`(全量正文在同目录 `transcript.jsonl`),本包不重复记一遍。包自己只补框架看不见的东西,走 `host.log` 落 `log.jsonl`:`shell 进程已启动`(pid/shell/cwd)、`命令超时,进程树已终止`(pid/timeoutMs/partialBytes)、`命令被中断,进程树已终止`(pid/partialBytes)、`命令没跑到收尾,回执不完整`(pid/exitCode)、`shell 进程启动失败`(shell/reason)、`工作目录建不出来,命令可能起不来`(cwd/reason)、`命令未获同意,没有执行`、`确认框没有给出答案,按拒绝处理`(error)、`命令命中免询问名单,没有询问`。

## RTK(可选,透明接入)

[rtk](https://github.com/rtk-ai/rtk) 是 CLI 输出压缩代理(`rtk git status` 把输出压小后再进模型)。RTK 只为 Claude Code、Cursor 等固定 agent 提供自动改写 hook,**没有 Cortico hook**,所以不能自动挂到本 World。这里的做法是**透明**:`suggestRtk` 开启时,World 启动用 `where/which rtk` 定位一次(只定位,**不执行** `rtk`),把结果写进环境提示词(`{{shell.rtk}}`),由 bot 自行决定给可压缩命令加 `rtk` 前缀。World 不改写任何命令。`worlds.shell.suggestRtk` 关掉这个提示,启动时也不探测;运行中再打开,下一次前缀重建时补探测。

## 配置段 `worlds.shell`

| 键 | 含义 | 热改 |
|---|---|---|
| `shell` | Niubash 的 niu 程序:PATH 里的命令名(默认 `niu`)或 `niu.exe` 的完整路径;每条命令都用它起新进程 | 是,下一条命令生效 |
| `cwd` | 每条命令的工作目录,留空用本部署目录(`WorldContext.botDir`:配置、记忆、运行数据所在;不是代码检出目录,安装版的代码检出目录在程序文件夹里,不该让 bot 往里写)。命令内 `cd` 只影响那条命令;目录不存在会在跑命令前建出来 | 是,下一条命令生效 |
| `ask` | 运行前是否先在桌面弹框问使用者,四档见上 | 是 |
| `grantMinutes` | `ask-once` 下同意管用多久 | 是 |
| `timeoutMs` | 单条命令超时,超过就终止那次调用的进程树并回报已产出的部分 | 是 |
| `maxOutputBytes` | stdout/stderr 各自字节上限,超出保头去尾;进程运行期间另有硬性内存上限,狂刷输出不会撑爆应用 | 是 |
| `suggestRtk` | 是否在环境提示词里提 rtk | 是 |

## 启用前置(preflight)

激活时校验 `niu --version` 的第一行是 `Niubash x.y.z` 且主版本 ≥ 1;否则报错(找不到 niu,或指到了别的程序),提示装 [niubash](https://github.com/unixwin/niubash) 或把 `worlds.shell.shell` 指向 `niu.exe`。

## 文件

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:id `shell`、默认配置、preflight、`describe`、`create()` |
| `src/config.ts` | 配置段类型、默认值、WebUI 配置组 |
| `src/world.ts` | `ShellWorld`:`shell_run`、审批闸门(`permit()`)、`approvalPreview()`、`webUi()` 声明、`envPromptVars()` |
| `src/ask.ts` | `askDesktop()`:koffi 调 `user32!MessageBoxTimeoutW` 弹原生「是/否」框(默认按钮「否」),返回 `yes`/`no`/`timeout`;`displayText()` 转义不可见控制符;`mapMessageBoxResult()` 是可测的纯函数 |
| `src/allow.ts` | 免询问名单:`readAllow`/`matchAllow`/`normalizeCommand`(整条命令原文比对,手写 JSON 数组,启动时读入) |
| `src/runner.ts` | `runCommand`:每次起一个 `niu -c`、收尾快照与 sentinel 协议、超时/中断终止进程树;`BoundedLog` 有界输出;`probeShellVersion` 与纯函数(`buildScript`/`splitSentinel`/`parseProcLine`/`truncateBytes`/`normalizeEol`/`stripAnsi`) |
| `src/rtk.ts` | `detectRtk()`:只定位,不执行 |
| `src/ENV_PROMPT.md` | 环境提示词模板 |
| `describe.json` | 扩展市场自描述;由 `pnpm describe:extension` 生成,发 npm 时要带上 |
| `CHANGELOG.md` | 版本发布说明;市场按 `## <版本>` 读取 |

## 开发

`D:\\project\\ts\\corti` 是各类扩展的开发根,一个包一个目录,本包在 `corti\\cortico-world-shell`。`cortico` 不发到 npm:`tsconfig.json` 与 `vitest.config.ts` 把 `cortico/*` 别名到 `../../Coo/vendor/cortico/src`(Coo 是 fork,只借它锁定的框架源码做类型检查与测试),与真实安装时运行时钩子的解析一致。运行时依赖只有 `koffi`(原生预编译模块,弹框用),`pnpm-workspace.yaml` 里已允许它的构建脚本。装好依赖后:

```bash
corepack pnpm install
pnpm typecheck && pnpm test
pnpm smoke            # 真起 niu 端到端验证(多行/here-doc、无状态、[bg]、超时/中断、[incomplete]),非 CI
SMOKE_ASK=12 pnpm smoke   # 顺带真弹一次确认框(12 秒内点「是/否」或等它自己超时)
```

world v6 的自描述与契约检查在 Cortico 仓库里跑(先 `describe:extension` 生成文件,再 `check:extension` 核对):

```bash
cd D:\project\ts\Coo\vendor\cortico
pnpm describe:extension D:\project\ts\corti\cortico-world-shell
pnpm check:extension    D:\project\ts\corti\cortico-world-shell
```

## 装进应用

这是独立的扩展包,不并进任何仓库:WebUI「扩展」页 →「手动安装」填本包目录的绝对路径 `D:\\project\\ts\\corti\\cortico-world-shell`,按 link 方式登记进应用的扩展目录,重启应用生效。

本包面向 Cortico **world v6**。本机安装的 `D:\\program\\Coopanion` 0.1.19 是 world v5,**不能加载 api 6 的包**;安装前确认应用是 v6 构建。数据在程序旁边的 `data\\`,扩展目录 `data\\extensions` 里就是 `pnpm` 维护的 `package.json` + `node_modules`;本包的运行时依赖只有 koffi,在本包目录 `pnpm install` 一次即可,之后 link 不联网。data 在程序目录外,升级应用不会丢扩展。手工登记等价于在 `data\\extensions\\package.json` 的 `dependencies` 里写:

```json
"cortico-world-shell": "link:D:\\project\\ts\\corti\\cortico-world-shell"
```

启用:扩展 World 不由 bot 声明,所以默认关闭,在 WebUI 本 World 页把 `worlds.shell.enabled` 打开(启用时跑 preflight 校验 niu),或改 `data\\home\\companion\\config.json` 里 `worlds.shell.enabled = true` 后重启。改源码后重启应用即生效。注意应用要能解析到 `niu`(PATH 里有;装 niubash 时会配好),否则在配置里填 `niu.exe` 的完整路径。

WebUI 没有本包的自定义页面(不注册 `cortico.webUiClient`),页面上的灯泡、徽章、配置项和提示词模板都由 `webUi()` 声明,用框架的通用渲染。
