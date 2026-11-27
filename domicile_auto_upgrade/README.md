# 自动建设助手 / Auto Construction Assistant（CK3 模组）

CK3 模组，作为合集仓库 `ck3-mods` 的一部分维护（仓库根目录 = CK3 模组文件夹）。

## 当前版本

- 版本：**0.14.4**（合集仓库标签 `domicile_auto_upgrade/v0.14.4`）
- 适配游戏版本：1.21.0.3
- Steam 创意工坊 ID：3811920217

## 目录说明

| 路径 | 内容 |
|---|---|
| `common/` | 游戏逻辑（脚本、效果、触发器、数值） |
| `events/` | 事件 |
| `gui/` | 界面定义 |
| `localization/` | 本地化文本 |
| `resources/` | 界面图片素材 |
| `tools/` | 辅助脚本（不参与游戏加载） |
| `descriptor.mod` | 模组元数据；**版本号改这里** |
| `thumbnail.png` | 启动器缩略图 |

## 日常使用（记住前三条就够）

```bat
git status                 :: 看改了哪些文件
git add -A                 :: 把改动放进本次存档
git commit -m "说明"       :: 存一个档
```

```bat
git log --oneline          :: 看历史
git diff                   :: 看具体改了什么
git tag                    :: 看所有版本标签
```

## 改坏了怎么回退

```bat
git checkout -- .                                     :: 丢掉未提交的修改，回到上次存档
git reset --hard domicile_auto_upgrade/v0.14.4        :: 回到某个标签版本（会覆盖工作区，谨慎）
```

## 发版流程

1. 改完 → 游戏内验收通过
2. 修改 `descriptor.mod` 里的 `version=`
3. 提交并打标签：
   ```bat
   git add -A
   git commit -m "[domicile_auto_upgrade] 0.14.5 修复：..."
   git tag domicile_auto_upgrade/v0.14.5
   ```
4. 用 `dau_wrapup/` 里的发布脚本打包、备份、安装
5. `git push` 推到合集仓库远程

> 发布 zip 不进仓库；上级目录的 `domicile_auto_upgrade.mod` 也不进仓库
> （它含本机绝对路径，换电脑失效，由发布脚本按机器生成）。

## 多设备同步

本模组已并入合集仓库 `ck3-mods`，多设备接入与日常用法见上级 `README.md`。

本模组的版本标签格式：`domicile_auto_upgrade/v<版本>`。

## 注意

- `.git` 是隐藏目录，CK3 不会读取，**不影响游戏加载**
- 不要把整个 `Crusader Kings III` 目录、存档、日志放进仓库
- 本地仓库不等于备份：必须 `git push` 到云端才有异地备份
