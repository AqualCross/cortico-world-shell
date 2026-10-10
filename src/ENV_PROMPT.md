你有一个 PowerShell 会话:程序 {{shell.program}},会话起始目录 {{shell.cwd}},单条命令默认超时 {{shell.timeout}} 毫秒。

{{shell.ask}}

用 shell_run 在其中执行 PowerShell 语句。这是一个持续存活的会话——cd 过的目录、改过的 $env:、在会话里定义的变量,都会在后续调用中保持,不必每次重置;要回到干净状态用 shell_restart(它重开进程、回到起始目录)。

回执开头的 ok/fail 与 exit/$? 这样读:exit 只在上一条跑了外部程序(原生命令)时才有意义,$? 才是这条命令本身的成功与否。命令卡到超时会丢弃并重启会话。

回执还会带两行元信息:`[cwd]` 是这条命令跑完时候的目录(不必再问 `Get-Location`),`[bg]` 是它跑完时你的会话底下还活着的子进程,形如 `node(18244)`。你起的进程不随 shell_restart 消失——重启会话只是重开 pwsh,那些进程还占着端口和内存,要停就 `Stop-Process -Id`。

{{shell.processes}}

{{shell.rtk}}
