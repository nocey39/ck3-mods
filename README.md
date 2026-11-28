# CK3 模组合集（私有仓库）

一个人维护的 CK3 1.21.0.3 模组套件（14 个模组）。本仓库根目录就是 CK3 本地模组文件夹：

`C:\Users\14232\Documents\Paradox Interactive\Crusader Kings III\mod\`

## 模组清单（当前基线）

| 文件夹 | 版本 | 创意工坊 ID |
|---|---|---|
| all_dynasty_legacies | 1.2.1 | — |
| army_auto | 0.10.8 | 3826772854 |
| auto_construction_estate_architect_patch | 0.2.0 | 3814660223 |
| court_auto | 1.7.4 | 3821363548 |
| court_pro | 1.21.0.3-update.1 | 3698328105 |
| culture_faith_reforged | 2.1.1 | 3692433159 |
| dau_hm_compat | 0.2.0 | 3826928848 |
| dejure_auto | 0.12.2 | 3825776871 |
| domicile_auto_upgrade | 0.14.4 | 3811920217 |
| family_development_assistant | 0.3.2 | — |
| region_conquest | 0.3.1 | 3813240200 |
| temple_citadel_change_local | 2.1.1 | 3700123247 |
| test | 1.21 | 3700121015 |
| treasury_equalization | 0.7.4 | 3839551460 |

国库统筹在另一台电脑继续排查时，请先阅读[故障机 Codex 交接](docs/treasury_equalization_handoff.md)。

## 日常使用

```bat
git status                          :: 看改了哪些模组
git add -A                          :: 收进本次存档
git commit -m "[army_auto] 修复..."  :: 存一个档（建议带模组前缀）
git push                            :: 推到云端
```

只看某个模组的改动和历史：

```bat
git diff -- army_auto
git log --oneline -- army_auto
```

## 版本标签约定

每个模组单独打标签，格式 `<文件夹名>/v<版本>`：

```bat
git tag army_auto/v0.10.9
git push origin army_auto/v0.10.9
```

## 换设备恢复

在新设备的 `...\Crusader Kings III\mod\` 目录里执行：

```bat
git init
git remote add origin https://github.com/nocey39/ck3-mods.git
git fetch origin
git checkout -f -b main origin/main
```

如果那台设备还没装这些本地模组，再运行一次：

```bat
powershell -ExecutionPolicy Bypass -File tools\make-mod-files.ps1
```

生成各模组的 `.mod` 指针文件（路径按当前电脑自动填写）。

## 为什么根目录的 .mod 文件不纳入仓库

- `<模组>.mod` 里有 `path="本机绝对路径"`，换电脑就失效，需要按机器重新生成
- `ugc_*.mod` 是创意工坊订阅的别人模组的指针，不属于本地源码

两者都在 `.gitignore` 里，需要时用 `tools/make-mod-files.ps1` 重建。

## 注意

- 不要删除 `.git` 目录（历史都在里面）
- 同一时间只在一台设备上改；开工前 `git pull`，收工后 `git push`
- 发布 zip 和根目录 `.mod` 指针不要手动加进仓库（`.gitignore` 已排除）
