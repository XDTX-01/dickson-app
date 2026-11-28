# 上传构建产物到腾讯云 COS（供 electron-updater 的 generic 源使用）
#
#   pwsh scripts/push-cos.ps1 -Dist .\dist -Bucket dickson-app-1313952720 -Region ap-guangzhou -Prefix app-update
#
# 传什么：安装包 + blockmap → latest.yml → latest.yml.sig（顺序固定，先包后清单）
# 为什么要顺序：客户端可能恰好在这几秒内拉清单，清单先上就会出现“清单指向的包还不存在”，
# 更新直接失败；反之包先上、清单后上是安全的（旧清单仍指向旧包）。
#
# 校验：每个文件传完都从 COS 下载回来算 SHA-256 和本地比对；
# 最后用 scripts/verify-update-sig.js 对着下载回来的清单验签，两步都过才算成功。
param(
    [Parameter(Mandatory = $false)] [string] $Dist = ".\dist",
    [Parameter(Mandatory = $true)]  [string] $Bucket,
    [Parameter(Mandatory = $false)] [string] $Region = "ap-guangzhou",
    [Parameter(Mandatory = $false)] [string] $Prefix = "app-update",
    [Parameter(Mandatory = $false)] [string] $Coscli = "",
    [Parameter(Mandatory = $false)] [string] $Pub = "",
    [Parameter(Mandatory = $false)] [switch] $DryRun
)

$ErrorActionPreference = "Stop"

# 绝对路径要原样用，不能无脑 Join-Path（否则会出现 C:\a\C:\a\dist 这种废话路径）
if (-not [System.IO.Path]::IsPathRooted($Dist)) {
    $Dist = Join-Path (Get-Location).Path $Dist
}
$Dist = (Resolve-Path -LiteralPath $Dist).Path

if (-not $Pub) {
    $Pub = Join-Path (Split-Path -Parent $PSCommandPath) "..\protect\verify-pub.json"
}
$Pub = [System.IO.Path]::GetFullPath($Pub)

$KeyId   = $env:COS_SECRET_ID
$KeySecret = $env:COS_SECRET_KEY
if (-not $DryRun) {
    if (-not $KeyId -or -not $KeySecret) {
        throw "缺少 COS_SECRET_ID / COS_SECRET_KEY 环境变量（GitHub Actions 里由 Secrets 注入）"
    }
}

# coscli 路径：显式传 > PATH > 当前目录
if (-not $Coscli) {
    $cmd = Get-Command coscli -ErrorAction SilentlyContinue
    if ($cmd) { $Coscli = $cmd.Source }
}
if (-not $Coscli -and -not $DryRun) { throw "找不到 coscli，请用 -Coscli 指定 coscli.exe 路径" }
if ($Coscli) {
    if (-not (Test-Path -LiteralPath $Coscli)) { throw "coscli 不存在：$Coscli" }
    $Coscli = (Resolve-Path -LiteralPath $Coscli).Path
}

# coscli 靠配置文件拿密钥，写临时配置，脚本结束即删
$cfgPath = Join-Path $env:TEMP ("cos-" + [guid]::NewGuid().ToString("N") + ".config.yaml")
if (-not $DryRun) {
    @"
cos:
  base:
    secret_id: $KeyId
    secret_key: $KeySecret
    protocol: https
"@ | Set-Content -LiteralPath $cfgPath -Encoding utf8
    $env:COSCLI_CONFIG = $cfgPath
}

function Get-Sha256([string] $File) {
    return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

$Prefix = $Prefix.Trim("/")
$CosBase = "cos://$Bucket/$Prefix"

# 收集待传文件：安装包 + blockmap + 清单 + 签名
$installers = @(Get-ChildItem -LiteralPath $Dist -File |
    Where-Object { $_.Name -match '\.(exe|msi|dmg|zip|AppImage)$' })
$blockmaps = @(Get-ChildItem -LiteralPath $Dist -File -Filter "*.blockmap")
$yml = Join-Path $Dist "latest.yml"
$sig = Join-Path $Dist "latest.yml.sig"

if ($installers.Count -eq 0) { throw "在 $Dist 里没找到安装包（electron-builder 产物应为 .exe）" }
if (-not (Test-Path -LiteralPath $yml)) { throw "缺少 latest.yml，先跑 electron-builder 和 sign-update.js" }
if (-not (Test-Path -LiteralPath $sig)) { throw "缺少 latest.yml.sig，先跑 node scripts/sign-update.js" }

# 传之前先本地验签：坏清单不上传
node (Join-Path (Split-Path -Parent $PSCommandPath) "verify-update-sig.js") --yml $yml --sig $sig --pub $Pub
if ($LASTEXITCODE -ne 0) { throw "本地清单验签失败，终止上传" }

$plan = New-Object System.Collections.Generic.List[object]
foreach ($f in ($installers + $blockmaps)) {
    $plan.Add([pscustomobject]@{ File = $f.FullName; Name = $f.Name; Cache = "max-age=604800" })
}
$plan.Add([pscustomobject]@{ File = $yml; Name = "latest.yml"; Cache = "no-cache" })
$plan.Add([pscustomobject]@{ File = $sig; Name = "latest.yml.sig"; Cache = "no-cache" })

foreach ($item in $plan) {
    $size = (Get-Item -LiteralPath $item.File).Length
    $hash = Get-Sha256 $item.File
    $remote = "$CosBase/$($item.Name)"
    Write-Host ("[push-cos] {0} -> {1} ({2:N0} bytes, sha256 {3})" -f $item.Name, $remote, $size, $hash.Substring(0, 16))

    if ($DryRun) { continue }

    $meta = "Cache-Control:$($item.Cache)"
    # coscli 的 cp 没有 --force 开关（传了会直接 unknown flag 退出），同名对象默认覆盖
    & $Coscli cp $item.File $remote --meta $meta
    if ($LASTEXITCODE -ne 0) { throw "上传失败：$($item.Name)" }

    # 回读比对：下载回来算哈希，和本地一致才算这次上传真的成功
    $tmp = Join-Path $env:TEMP ("verify-" + [guid]::NewGuid().ToString("N") + "-" + $item.Name)
    try {
        & $Coscli cp $remote $tmp
        if ($LASTEXITCODE -ne 0) { throw "回读失败：$($item.Name)" }
        $remoteHash = Get-Sha256 $tmp
        if ($remoteHash -ne $hash) {
            throw "回读哈希不一致：$($item.Name) 本地 $hash / 远端 $remoteHash"
        }
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    }
    Write-Host "[push-cos]   回读校验通过"
}

if (-not $DryRun) {
    # 最后再从 COS 把清单+签名拉回来验一次：确认线上这对文件是配对的
    $tmpYml = Join-Path $env:TEMP ("cosyml-" + [guid]::NewGuid().ToString("N") + ".yml")
    $tmpSig = Join-Path $env:TEMP ("cosyml-" + [guid]::NewGuid().ToString("N") + ".sig")
    try {
        & $Coscli cp "$CosBase/latest.yml" $tmpYml
        & $Coscli cp "$CosBase/latest.yml.sig" $tmpSig
        if ($LASTEXITCODE -ne 0) { throw "线上清单回读失败" }
        node (Join-Path (Split-Path -Parent $PSCommandPath) "verify-update-sig.js") --yml $tmpYml --sig $tmpSig --pub $Pub
        if ($LASTEXITCODE -ne 0) { throw "线上清单验签失败" }
    } finally {
        foreach ($t in @($tmpYml, $tmpSig)) { if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force } }
    }
    Write-Host "[push-cos] 全部完成：$CosBase"
    Write-Host "[push-cos] 客户端更新源 = https://$Bucket.cos-website.$Region.myqcloud.com/$Prefix/"
}

if (-not $DryRun -and (Test-Path -LiteralPath $cfgPath)) {
    Remove-Item -LiteralPath $cfgPath -Force
    Remove-Item Env:\COSCLI_CONFIG -ErrorAction SilentlyContinue
}
