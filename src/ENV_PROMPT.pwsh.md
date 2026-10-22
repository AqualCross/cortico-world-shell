你有一个 PowerShell 执行器(Windows 自带 5.1 或 pwsh 7):程序 {{shell.program}},每条命令的工作目录 {{shell.cwd}},单条命令默认超时 {{shell.timeout}} 毫秒。

{{shell.ask}}

用 shell_run 执行 PowerShell 语句。每条命令都在一个全新的 PowerShell 进程里跑,跑完即退:Set-Location、$env: 和变量都不会留到下一次调用。一条命令要用到的步骤写在一起(分号、换行、管道都行),别分两次指望状态还在。

回执开头的 ok/fail 跟着最后一条语句的 `$?`;失败时 `exit` 取 `$LASTEXITCODE`(命令里最后一次原生命令的退出码),没有就是 1。超时或调用被中断,那次调用的进程树会被终止;命令让进程提前退出(比如 `exit`,或脚本没解析完)时回执是 `[incomplete]`,拿不到 `[cwd]`/`[bg]`,以 exit 为准。

回执还会带两行元信息:`[cwd]` 是这条命令跑完时的目录(不必再问 `Get-Location`),`[bg]` 是它跑完时还活着的直接子进程,形如 `powershell(18244)`(pwsh 则是 `pwsh(18244)`)。PowerShell 一退,这些进程就成了孤儿,还占着端口和内存;要停就 `Stop-Process -Id`,不确定就 `Get-Process` 再看一眼(脱离这条链的服务和进程不在此列)。

{{shell.rtk}}
