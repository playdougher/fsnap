# 状态备份脚本 (fsnap) 最终设计方案 (Final Design)

## 1. 核心存储策略
采用 **"时间戳快照 (Snapshot-based)"** 模式,优先保证恢复的原子性和管理的简易性。

*   **根目录**: `$ST_ROOT/ (默认: $HOME/.local/share/fsnap/)`
*   **快照 ID**: `YYYYMMDD_HHMMSS` (纯数字时间戳,保证固定长度且无特殊字符)。
*   **物理结构**:
    ```text
    $ST_ROOT/
    ├── index.log               # 全局索引文件 (追加模式)
    └── 20260428_180000/        # 快照目录
        ├── desc.txt            # 完整描述信息
        └── home/               # rsync 镜像的真实数据 (保留完整绝对路径)
            └── user/ ...
    ```

## 2. 关键组件说明
### A. 目录内描述 (desc.txt)
*   **作用**: 保证备份的"自包含性"。即便索引文件丢失，每个备份依然包含自己的身份信息。

### B. 全局索引 (index.log)
*   **格式**: `ID | TARGET_PATH | DESCRIPTION_SUMMARY`
*   **作用**: 解决"查询历史"的需求。通过 `grep` 索引文件,可以瞬间查出某个路径在哪些 ID 中被备份过。

### C. 移除快照 (Deletion Logic)
*   **物理同步**: 必须同时删除备份目录 `$ST_ROOT/$ID` 和索引文件 `$INDEX` 中的对应条目。
*   **幂等性**: 如果目录不存在但索引存在(或反之),删除操作应能容错处理。
*   **安全性**: ID 使用 `^` 锚定匹配,确保只删除以该 ID 开头的行。

## 3. 改进后的命令逻辑
| 命令 | 逻辑实现 |
| :--- | :--- |
| **Save (s)** | 1. 生成 ID；2. 写入 `desc.txt`；3. 追加一行到 `index.log`；4. `rsync -rltDR --chmod=u+w`（文件原权限不保留，确保备份目录始终可写可删）。 |
| **View (v)** | 1. 读取 `desc.txt`；2. 列出备份文件清单；3. 显示占用空间。 |
| **List (l)** | 1. 倒序读取 `index.log`；若不存在则降级为读取目录名。 |
| **Delete (d)** | 1. 定位快照目录和索引条目；2. 确认后删除目录并移除索引行；3. `-f` 跳过确认。
    > 注：查找用 `^ID`（显示用），删除用 `^ID |` 严格匹配。`grep -v` 后用 `;` 而非 `&&` 连接 `mv`，避免单条记录时 grep 返回非零退出码导致 `mv` 跳过。 |
| **Restore (r)** | 1. `rsync -Orlt --exclude="desc.txt" --out-format="%n" $SNAP/ /`，输出变更文件列表。 |
| **Help** | 显示帮助信息，支持 `help`、`?`、空参数三种方式。 |

## 4. 扩展生态

### pi coding agent 插件
`plugins/pi/auto-backup.ts` 将 fsnap 集成到 [pi coding agent](https://github.com/mariozechner/pi-coding-agent) 中，注册了两个自定义工具：

*   **`backup`**：在 LLM 编辑文件前自动调用 `fsnap s` 创建快照，含描述校验和通知。
*   **`restore`**：两步式恢复流程——(1) 搜索快照返回候选列表，(2) LLM 匹配后调用 `fsnap r` 恢复，带用户确认弹窗。

## 5. 优化点与权衡 (Trade-offs)
*   **路径冗余**: 虽然备份目录下会有多层空目录(如 `home/user/...`),但换取了"一键恢复到根目录"的极端便利和安全性。
*   **并发安全**: 脚本简单处理追加写入,暂不引入复杂的锁机制(假设单人操作)。
*   **旧版本兼容**: 脚本在 `list` 时应检测 `index.log`,若不存在则降级为读取目录名。
