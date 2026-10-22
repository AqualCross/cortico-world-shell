# Changelog

## 0.1.0

- 每条命令在全新的 Niubash 进程里执行;超时或中断终止这次调用的进程树,停用 World 会中止在途调用,回执用 `[bg]` 报出仍存活的直接子进程。
- 审批框显示工作目录、程序与命令头尾;默认按钮为「否」;命令上限 8000 字;控制符与双向字符转义后显示。
- 免询问名单在 World 启动时读取;RTK 只在开启提示时定位,不执行。
- 输出有界;收尾在捕获 `$?` 后 `set +e`,`set -euo pipefail` 的命令也能拿到 `[cwd]`/`[bg]`。
- 适配 Cortico world v6:`webUi()` 与 `describe.json`;仅支持 Windows。
