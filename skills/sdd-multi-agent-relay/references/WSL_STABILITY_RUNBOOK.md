# WSL2 中断、假死排查与修复手册（跨设备通用）

> 本手册沉淀自真实跨端挂机踩坑复盘，适用于 **Windows + WSL2 + VS Code Codex / Antigravity** 长期运行环境。遇到新设备同样频繁出现 WSL 卡死、`WSAETIMEDOUT` 或会话莫名断连时，可按以下清单**先快速取证 → 一次性根治 → 应急恢复**。

---

## 一、常见症状与真实根因对照

| 现场表现 / 报错 | 真实根因 | 本手册对应章节 |
| :--- | :--- | :--- |
| `wsl.exe` 全部超时，报 **`Wsl/Service/WSAETIMEDOUT`**；`wsl -l -v` 仍显示 `Running` 但无法进入 bash | Windows 开启 `networkingMode=mirrored`（镜像网络），与代理软件 TUN 虚拟网卡、物理网卡切换冲突，导致 Hyper-V 虚拟交换机 **`FSE HostVnic`** 阻塞卡死 | [§二.1](#21-移除-mirrored-镜像网络回退稳定-nat)、[§三](#三wsl-已经假死--中断时的-3-级应急恢复) |
| WSL2 会话突然断掉、VS Code 报重连或部分进程丢失，Windows 日志出现 **`Tcpip ID=4231`** | Windows 默认动态 TCP 短端口池仅有 `16,384` 个（`49152–65535`）；长时跑浏览器/微服务/压测把短端口池打满 | [§二.3](#23-扩容-windows-动态-tcp-短端口池) |
| 编译或跑测试时 WSL 整体卡顿甚至 IO 阻塞卡死 | 代码仓库、Rust `target/`、`node_modules` 或 SQLite 放在 **`/mnt/<drive>/`** 下，跨 9P/DrvFS 协议高频小文件 I/O 拖死通道 | [§二.4](#24-代码与高频缓存坚持放在-linux-ext4-分区) |
| Codex 会话已断，但之前拉起的测试（如 `cargo test` / `node worker`）挂在 `PID 1` 后台空跑 | 会话退出后测试子进程变为**孤儿进程**，仍占内存/端口/文件锁，甚至让巡检误判会话还在工作 | [§五](#五配合-sdd-multi-agent-relay-自动化防护速查) |

---

## 二、新设备 / 故障设备一次性根治清单（4 步）

### 2.1 移除 `mirrored` 镜像网络，回退稳定 `nat`

> **为什么**：WSL2 默认 `nat` 模式经过多年打磨极稳定；而 `networkingMode=mirrored` 会把宿主机所有物理网卡和代理 TUN 网卡实时镜像进 WSL（依赖 `FSE HostVnic`），在代理切节点或 Wi-Fi 波动时极易把整个 `WslService` 通信通道拖死。

在 **Windows PowerShell** 中先备份原配置，再改写 `$env:USERPROFILE\.wslconfig`：

```powershell
if (Test-Path "$env:USERPROFILE\.wslconfig") {
  Copy-Item "$env:USERPROFILE\.wslconfig" "$env:USERPROFILE\.wslconfig.bak" -Force
}

Set-Content -Path "$env:USERPROFILE\.wslconfig" -Value @"
[wsl2]
autoProxy=true
autoMemoryReclaim=gradual
"@ -Encoding ascii
```

- **内存说明**：不写 `memory=` 时，WSL2 默认上限约为宿主机物理内存的一半（如 32GB 宿主机默认约 16GB），配合 `autoMemoryReclaim=gradual` 会在空闲时温和回收内存给宿主机；若宿主机仅 16GB 或更小，可额外加一行 `memory=8GB`。
- **生效方式**：需执行一次 `wsl --shutdown` 后生效（建议等当前正在运行的编译/Codex 轮次停稳后再重启，不要在写文件或 `git commit` 中途强杀）。

---

### 2.2 检查并清理 WSL 内残留的旧硬编码代理

从 `mirrored` 切回 `nat` 后，最容易踩的坑是**以前手写过宿主机 IP 代理环境变量**（例如写死了某个旧的 `172.x.x.1:7891`）。切回 `nat` 后宿主机虚拟网关 IP 会重新分配，继续指向旧 IP 会导致断网。

1. 在 WSL 内检查是否有残留硬编码代理：
   ```bash
   grep -rnE "http_proxy|https_proxy|all_proxy|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY" \
     ~/.bashrc ~/.profile ~/.zshrc /etc/environment /etc/profile /etc/profile.d 2>/dev/null || true
   ```
2. **建议做法**：
   - 若 Windows 代理软件已开启 **TUN 模式**，或依靠 `$env:USERPROFILE\.wslconfig` 的 **`autoProxy=true`** 自动映射代理，直接注释/删除上述文件里写死旧 `172.x.x.1` 的行；
   - 若不用 TUN、必须手动走 HTTP 代理，请确保代理软件开启 **Allow LAN（允许局域网）**，并用动态宿主机网关取址（而非写死固定 IP）。
3. 重启 WSL 后验证环境变量与外网连通：
   ```bash
   env | grep -i proxy || true
   curl -I --max-time 8 https://api.openai.com || true
   ```

---

### 2.3 扩容 Windows 动态 TCP 短端口池

用**管理员身份**打开 Windows PowerShell 执行：

```powershell
netsh int ipv4 set dynamicport tcp start=20000 num=45535
netsh int ipv4 show dynamicport tcp
```

确认输出中 `Number of Ports`（端口数）已变为 **`45535`**（原默认值仅 `16384`），可基本杜绝高并发测试打满短端口引发 `Tcpip 4231`。

---

### 2.4 代码与高频缓存坚持放在 Linux ext4 分区

- 仓库目录与工作区务必放在 WSL 原生 Linux 分区（例如 `~/work/<repo>`，即 `/home/<user>/...`），**不要放在 `/mnt/c/...` 或 `/mnt/d/...`**。
- 检查构建缓存与临时目录位置：
  ```bash
  df -h / "$HOME" /tmp
  echo "CARGO_HOME=${CARGO_HOME:-~/.cargo} CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-repo/target} TMPDIR=${TMPDIR:-/tmp}"
  ```
- 保证 `/home/<user>` 挂载在原生 ext4 虚拟盘，`/tmp` 在 `tmpfs` 或 ext4 上；严禁把 `CARGO_TARGET_DIR`、`node_modules` 或高频 SQLite 指向 `/mnt/<drive>/`。

---

## 三、WSL 已经假死 / 中断时的 3 级应急恢复

发生 `WSAETIMEDOUT` 或长期无响应时，按从轻到重依次处理（**代码、Git 提交与 `~/.codex/sessions/` 均持久化在磁盘上，不会丢失**）：

### 第 1 级：重启 WSL 虚拟机（绝大多数场景 5 秒恢复）

```powershell
wsl --shutdown
Start-Sleep -Seconds 3
wsl -l -v
wsl -e echo WSL_OK
```

### 第 2 级：重启 Windows `WslService` 与计算服务（免重启电脑）

如果连 `wsl --shutdown` 本身也卡死不返回，用**管理员 PowerShell** 执行：

```powershell
Restart-Service WslService -Force
# 若仍报错或超时，再重启 Hyper-V 主机计算服务：
Restart-Service vmcompute -Force
Start-Sleep -Seconds 3
wsl -e echo WSL_OK
```

### 第 3 级：重启后收尾（必做 3 件事，防止无声掉线）

1. **检查 Git 锁残留**：若中断瞬间正好在跑 `git` 命令，先在仓库检查是否存在孤立锁文件：
   ```bash
   ls -la .git/index.lock 2>/dev/null || echo "NO_GIT_LOCK"
   ```
   确认确实无活跃 `git` 进程后才可清理 `.git/index.lock`。
2. **清理残留孤儿进程（如有）**：检查是否还有上次测试留下的 `PID 1` 孤儿进程占着端口或锁文件（可用 `relay.mjs procs` 识别）。
3. **点活双端 Codex 标签页**：WSL 重启后，之前 VS Code 里打开的 Codex 标签页大概率已断开与后端 `app-server` 的挂载。请在 VS Code 里把 **`Codex-Hub`** 和 **`AB`** 两个标签页重新点一下 / 发一句确认使其重新上线。

---

## 四、快速取证诊断命令（判断另一台设备是不是同源问题）

在故障机器的 **Windows PowerShell** 运行以下只读脚本，直接看过去 24 小时是否命中 `Tcpip 4231` 与 `FSE HostVnic` 报错：

```powershell
$since = (Get-Date).AddHours(-24)

Write-Host "=== 1. .wslconfig ==="
if (Test-Path "$env:USERPROFILE\.wslconfig") { Get-Content "$env:USERPROFILE\.wslconfig" } else { "(none)" }

Write-Host "`n=== 2. TCP Dynamic Port Pool ==="
netsh int ipv4 show dynamicport tcp

Write-Host "`n=== 3. Tcpip 4231 (Ephemeral Port Exhaustion) ==="
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Tcpip'; Id=4231; StartTime=$since} -ErrorAction SilentlyContinue |
  Select-Object -First 10 TimeCreated, Id, Message | Format-Table -AutoSize -Wrap

Write-Host "`n=== 4. Hyper-V VmSwitch Errors (ID 148 / 285) ==="
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Hyper-V-VmSwitch-Operational'; StartTime=$since} -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 148, 285 } |
  Group-Object Id |
  Select-Object Name, Count | Format-Table -AutoSize
```

若第 1 项看到 `networkingMode=mirrored`、第 4 项 `ID=148/285` 成百上千条、或第 3 项有 `Tcpip 4231`，即可直接按本手册[§二](#二新设备--故障设备一次性根治清单4-步)根治。

---

## 五、配合 `sdd-multi-agent-relay` 自动化防护速查

更新至 **`v1.3.3+`** 后，插件已内置覆盖事前、事中、事后的自动化体检与告警命令（在任意机器安装后即可使用）：

```powershell
# 1. 一键安装/更新插件与双端 Skill（含同步到 WSL）
node ./bin/cli.mjs update --mode plugin --dedupe --with-codex --wsl-distro Debian

# 2. 宿主机健康体检（自动检测 Windows 短端口池 <30000 与 .wslconfig mirrored 风险）
node ./bin/cli.mjs doctor

# 3. 项目防漂移体检（在 runtime="wsl" 下自动预警 /mnt/<drive>/ 跨盘 9P/DrvFS 路径）
node ./bin/cli.mjs analyze --project "<项目目录>" --json

# 4. 后台进程 ppid 血缘核查（区分真正附着在存活 codex 下的任务 vs PID 1 孤儿进程）
node ./bin/cli.mjs procs --project "<项目目录>" --json

# 5. 全局状态巡检（自动包含重启感知 environmentRestart 与投递 1 周期未消费告警 unconsumedPushes）
node ./bin/cli.mjs status --project "<项目目录>" --json

# 6. 重启/点活窗口确认后手动消警（全部绑定会话恢复写入后重启告警也会自动消警）
node ./bin/cli.mjs state ack-alert --project "<项目目录>" --kind all
```
