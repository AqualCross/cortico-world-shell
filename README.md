# cortico-world-shell

Owner: `src/definition.ts`

Cortico World 扩展:在一个**持续存活的 PowerShell 7 (pwsh) 会话**里执行命令。`cd` 过的目录、改过的 `$env:`、会话内定义的变量在多次 `shell_run` 之间保留;命令超时则丢弃并重启会话。默认**每一轮的第一条命令先在桌面上问使用者同意**(`worlds.shell.ask`,四档,最严可调成每条都问、最松可完全不问)。

装配挂载时投 `example.started` 类事件这里不需要,故本 World 只在工具被调用时才拉起 pwsh 进程(禁用/未调用时零副作用)。

## 工具

| 工具 | 作用 |
|---|---|
| `shell_run` | 执行一条 PowerShell 语句(可多行),回执含 `[ok]`/`[fail]`、`exit`(上一条外部程序的码)、`$?`(这条命令本身的成败)、`[cwd]`(跑完时的目录)、`[bg]`(跑完后还活着的子进程)、stdout、`[stderr]`。按 `worlds.shell.ask` 可能先弹框问使用者,没同意就是 `[未执行]` 回执。 |
| `shell_restart` | 丢弃当前会话,重开全新 pwsh 进程:回到起始目录、清空会话变量。改了 `shell`/`cwd` 后用它生效。**它不停下你起的进程**,回执会列出还挂着的那些。 |

## 先问你(`worlds.shell.ask`)

和电脑操作 World 同一套四档:`ask-each-command`(每条命令都弹框)、`ask-each-turn`(每一轮第一条命令前问一次,默认)、`ask-once`(问一次,同意后 `grantMinutes` 分钟内不再问)、`never-ask`(都不问)。

批准必须落在模型之外,否则它自己就能伪造一句"使用者同意了"。而扩展这一层拿不到应用注入给 CUA 的 `askPermission`(`pet.confirm` 是应用侧的东西),`WorldHost` 也没有问人的接口,所以本包自己在桌面上弹一个三按钮的小窗:「总是允许这条」/「只这次允许」/「拒绝」,60 秒没人点按拒绝算。它另起一个短命 pwsh,不坐在这条工作会话里,所以拒绝、超时、中断都不会污染会话状态。回车和 Esc 都落在「拒绝」,只有明确点允许才放行。

实现上几个坑,都踩过:

- 原生 `MessageBox` 的按钮文字是系统写死的,给不了自定义按钮,所以窗口是 PowerShell 里现搭的 WinForms 表单(不是编译 C#:pwsh 7 的 `Add-Type -TypeDefinition` 即使先 `Add-Type -AssemblyName` 也解析不到 `System.Windows.Forms`,报 CS0234,而类型本身在加载后可以直接用)。`pwsh` 默认起在 MTA,WinForms 要单线程套间,所以进程带 `-STA`。
- 脚本用 `-EncodedCommand`(Base64 + UTF-16LE)传,不走 `-Command -` 的 stdin:后者按行解析,问题文本里的多行命令会把字符串截断,进程 0 退出、不弹框也不报错。
- 命令原文是模型写的东西,只能作为**单引号字面量**进脚本,绝不能塞进 `@'…'@` here-string:命令里只要有一行以 `'@` 开头就能提前关掉那段字符串,把审批脚本变成它想跑的任何代码——绕过这道闸本身。`tests/ask.test.ts` 里钉着这个用例。
- 弹框进程**不能**用 `windowsHide: true` 启动。那个启动位(SW_HIDE)不只压掉控制台,WinForms 会把它用在自己的第一个窗口上:模态循环照跑、计时器照响、60 秒后自己超时,桌面上从头到尾什么都没有。改成 `windowsHide: false` 加 `-WindowStyle Hidden`,由 PowerShell 自己藏控制台,窗口就正常出现。

- 未获同意时命令**根本没有进会话**,回执是 `[未执行] …不要换个写法重试,等使用者开口。`,并落一条 `warn`(含命令前 500 字和答案)。拒绝在本轮内对所有后续命令有效,`onTurnEnded()` 后重新问。
- 环境提示词里有 `{{shell.ask}}` 说明当前档位;控制台有「先问你」徽章,等回答时「在等你点头」灯泡亮着。
- 弹框里能看到命令原文(超 500 字会截断,全文在 `toolcalls.jsonl`)。`never-ask` 就是把这道闸整个拆掉,只在信任它的时候用。

## 免询问名单(`allowlist.json`)

点「总是允许这条」时,World 把**那条命令的原文**记进 `<dataDir>/shell/allowlist.json`,下次同一条命令直接放行、不再弹框(那一次照常执行,不会因为要写名单而漏掉)。

- 匹配只认整条命令的原文:先去掉首尾空白、统一换行风格,再逐字比对。`git status` 在名单里,`git status -s` 照样要问——多个参数就是另一条命令。没有前缀匹配、没有通配符、也不看程序名。
- 名单是一个普通 JSON 数组文件,你可以自己用编辑器加、删、改,不必等点按钮。上限 200 条,写满了不再追加(下次还会问)。文件坏了、不是数组、路径是个目录 → 当作没有名单,该问还是问,不会因为读不了就放行。
- 每一次命中都落一条 `info` 日志,所以「这条什么时候开始不问的」查得到。
- 一句实话:**这不是安全边界。**bot 手里就有一条 shell,它想就能自己写这个文件。名单存在的意义是少点几次鼠标,不是把某条命令变成免检;真要收紧就把 `ask` 调成 `ask-each-command`,环境提示词里也写明了不许它开口要你把它常用的命令加进名单。

## 进程可见性

自动记忆(GitMem)只存 bot 自己写下的文字,不采集任何进程信息;命令一返回,stdout 就没了,而它 `Start-Process` 起来的东西还在跑。所以「它开了哪些进程」必须由 World 记着,和 life World 把心情/精力挂在实例上再投影到控制台是同一个套路:

- 每条命令跑完,会话里顺手查一次自己的直接子进程(`Get-CimInstance Win32_Process -Filter "ParentProcessId=$PID AND Name!='conhost.exe'"`,上限 30 条,`conhost.exe` 是 Windows 挂给 pwsh 的控制台宿主,不算它起的),结果**整份替换**内存里的快照,所以不会漂移——下次快照里没了就是真没了。快照和 sentinel 写在同一次 stdin 写入里,不多一次往返,实测每条命令多约 20ms。
- 三个出口:回执里的 `[bg] node(18244)`(排在 stdout 前,免得被控制台的回执截断挤掉)、控制台徽章「它起的进程」、环境提示词 `{{shell.processes}}`(带命令行前 90 字,并说明它不随 `shell_restart` 消失)。
- 会话被丢弃/重启/关闭时若还有子进程活着,`log.jsonl` 落一条 `warn`,列清名字和 pid。
- 边界:只看得见 pwsh 的**直接子进程**。脱离这条链的东西(注册服务、计划任务、父进程已换的孤儿进程)不在快照里;环境提示词把这条边界写在明面上,真要查得自己跑 `Get-Process`。

## 上一代留下的会话

会话活着的时候给自己登记一行:`<dataDir>/shell/session.json` 里写 `{pid, startedMs, shell, cwd}`(按 World 分目录,同一台机器上两套部署不会互相认领别人)。正常关闭(`dispose()`、超时丢弃、`shell_restart`)会把它删掉,下一代就没活可干。

下一代开新的 pwsh 时读这条记录,发现还留着一个进程,就在**刚起来的这个会话里**跑一条命令核验后处理它(不另起进程):

- 三个条件全中才算自己的前任——同一个可执行文件(`pwsh.exe` 对 `pwsh`)、命令行带我们那套 `-NoProfile -NoLogo -NonInteractive -Command`、系统记录的出生时间落在 `startedMs ±10 秒`内。
- 全中才 `Stop-Process`,而且**只杀那个 pwsh**:它手里挂着的外部命令杀不掉(也不是我们该替它决定的),把它们列进日志的 `left` 里点名。
- 任一条件不中(最常见的是 pid 被别的程序复用、或者那是别人启动的 pwsh)一律不碰,日志落 `上一代留下的会话没认领 {reason}`(`not-ours` / `still-alive` / 读不出答案)。抢走别人的 shell 比漏掉我们自己的一个 pwsh 严重得多。
- 记录读不出、JSON 坏了、pid 不合法 → 当作没有,不做任何猜测。

关于成因,一句实话:`pwsh -Command -` 在等 stdin,应用被强杀时这根管道的写端随宿主一起关闭,shell 收到 EOF 基本会跟着退掉——所以崩溃**通常**不留孤儿。真留下的是两类:有别的进程继承了这根管道还握着写端,或者 shell 正卡在外面那条命令里回不到读。这段认领不关心成因,只要那个状态存在就被清掉。

实现上两个坑值得记:认领脚本每行必须是**完整语句**(`pwsh -Command -` 逐行解析,单独占一行的 `elseif` 是语法错误,会把整段连会话自己的 sentinel 一起吞掉);进程出生时间不能用 CIM 的 `CreationDate`(到 pwsh 手里是字符串,`.ToDateTime()` 直接抛),取 `Get-Process` 的 `StartTime`,读不到就落在时间窗外——也就是不动它。

## 追踪

每条命令的原文、耗时、回执前 600 字由框架记在 `data/runs/<run>/toolcalls.jsonl`(全量正文在同目录 `transcript.jsonl`),本包不重复记一遍。包自己只补框架看不见的东西 —— pwsh 进程的生死,走 `host.log` 落 `log.jsonl`:`pwsh 会话已启动`(shell/pid/cwd)、`pwsh 会话进程结束`(code/signal,非本包所为)、`pwsh 会话启动失败`、`命令超时/被中断`(会话状态未知还是直接丢弃)、`按请求重启会话`、`命令未获同意,没有执行`、`确认框没有给出答案,按拒绝处理`(exitCode/stdout/stderr 或 `stalled`,用来分清「你点了拒绝」和「框根本没起来」)、`命令命中免询问名单,没有询问`、`这条命令已记入免询问名单`(file/count)、`免询问名单没写进去,下次还会问`(file/reason)、`会话已丢弃,它起的进程仍在运行`、`会话已关闭`、`清掉了上一代遗留的 PowerShell 会话`(pid/started/left)、`上一代留下的会话没认领`(pid/reason/left)、`认领上一代会话时出错`、`会话记录写不下去,崩掉后就没人认领它了`。

## RTK(可选,透明接入)

[rtk](https://github.com/rtk-ai/rtk) 是 CLI 输出压缩代理(`rtk git status` 把输出压小后再进模型)。RTK 只为 Claude Code、Cursor 等固定 agent 提供自动改写 hook,**没有 Cortico hook**,所以不能自动挂到本 World。这里的做法是**透明**:World 启动时用 `where/which rtk` 探测一次,把结果写进环境提示词(`{{shell.rtk}}`),由 bot 自行决定给可压缩命令加 `rtk` 前缀。World 不改写任何命令。`worlds.shell.suggestRtk` 关掉这个提示。

## 配置段 `worlds.shell`

| 键 | 含义 | 热改 |
|---|---|---|
| `shell` | pwsh 程序:PATH 里的命令名(默认 `pwsh`)或完整路径 | 否,需 `shell_restart` |
| `cwd` | 新会话起始目录,留空用本部署目录(`WorldContext.botDir`:配置、记忆、运行数据所在;不是代码检出目录,安装版的代码检出目录在程序文件夹里,不该让 bot 往里写)。填的目录不存在会在开会话时建出来 | 否,需 `shell_restart` |
| `ask` | 运行前是否先在桌面弹框问使用者,四档见上 | 是 |
| `grantMinutes` | `ask-once` 下同意管用多久 | 是 |
| `timeoutMs` | 单条命令超时,超时丢弃并重启会话 | 是 |
| `maxOutputBytes` | stdout/stderr 各自字节上限,超出保头去尾 | 是 |
| `suggestRtk` | 是否在环境提示词里提 rtk | 是 |

## 启用前置(preflight)

激活时校验 `shell --version` 能跑且主版本 ≥ 7;否则报错(找不到 pwsh,或指到了 Windows PowerShell 5.1),提示装 pwsh7 或把 `worlds.shell.shell` 指向 pwsh。

## 文件

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:id `shell`、默认配置、preflight、`create()` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/world.ts` | `ShellWorld`:两个工具、审批闸门(`permit()`)、`console()` 声明、`envPromptVars()` |
| `src/ask.ts` | `askDesktop()`:另起 pwsh(`-STA -WindowStyle Hidden`,`-EncodedCommand` 传脚本)弹三按钮桌面窗,返回 `yes`/`always`/`no`/`timeout`;`encodeAskScript()` 是可测的纯函数 |
| `src/allow.ts` | 免询问名单:`readAllow`/`matchAllow`/`addAllow`/`normalizeCommand`(整条命令原文比对,上限 200 条) |
| `src/session.ts` | `PwshSession` 持久会话(sentinel + 进程快照协议)、`probeShellVersion` 与纯函数(`splitSentinel`/`parseLive`/`truncateBytes`/`normalizeEol`) |
| `src/claim.ts` | 会话自登记与认领:`writeRecord`/`readRecord`/`clearRecord`(那个 `session.json`)、`claimCommand()`(每行一条完整语句的核验+清理脚本)、`parseClaim()` |
| `src/rtk.ts` | `detectRtk()` |
| `src/ENV_PROMPT.md` | 环境提示词模板 |

## 开发

`D:\\project\\ts\\corti` 是各类扩展的开发根,一个包一个目录,本包在 `corti\\cortico-world-shell`。`cortico` 不发到 npm:`tsconfig.json` 与 `vitest.config.ts` 把 `cortico/*` 别名到 `../../Coo/vendor/cortico/src`(Coo 是 fork,只借它锁定的框架源码做类型检查与测试),与真实安装时运行时钩子的解析一致。装好依赖后:

```bash
corepack pnpm install
pnpm typecheck && pnpm test
pnpm smoke            # 真起一个 pwsh 端到端验证,非 CI
SMOKE_ASK=12 pnpm smoke   # 顺带在桌面上真弹一次审批框(12 秒内点「是」或等它自己超时)
```

## 装进应用

这是独立的扩展包,不并进任何仓库:控制台「扩展」页 →「手动安装」填本包目录的绝对路径 `D:\\project\\ts\\corti\\cortico-world-shell`,按 link 方式登记进应用的扩展目录,重启应用生效。

本机安装的正式版在 `D:\\program\\Coopanion`(0.1.19,扩展契约 world v5 / provider v5,与本包 `cortico.api` 一致),数据在程序旁边的 `data\\`,扩展目录 `data\\extensions` 里就是 `pnpm` 维护的 `package.json` + `node_modules`;本包运行时没有依赖,link 不联网。data 在程序目录外,升级应用不会丢扩展。手工登记等价于在 `data\\extensions\\package.json` 的 `dependencies` 里写:

```json
"cortico-world-shell": "link:D:\\project\\ts\\corti\\cortico-world-shell"
```

启用:扩展 World 不由 bot 声明,所以默认关闭,在控制台本 World 页把 `worlds.shell.enabled` 打开(启用时跑 preflight 校验 pwsh 7),或改 `data\\home\\companion\\config.json` 里 `worlds.shell.enabled = true` 后重启。改源码后重启应用即生效。

控制台没有本包的自定义页面(不注册 `cortico.consoleClient`),页面上的灯泡、徽章、配置项和提示词模板都由 `console()` 声明,用框架的通用渲染。

