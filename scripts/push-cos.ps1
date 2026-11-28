<#
# 上传构建产物到腾讯云 COS（供 electron-updater generic 源使用）
#
#   pwsh scripts/push-cos.ps1 -Dist .\dist -Bucket dickson-app-1313952720 -Region ap-guangzhou -Prefix app-update
#
# 适配静态托管桶禁止HEAD：
# 1. 上传使用coscli（PUT，无HEAD问题）
# 2. exe/blockmap上传成功后不下载回读校验
# 3. yml/sig线上验签改用静态域名GET下载，避开coscli自带HEAD探测
# 4. 末尾自动清理旧exe+blockmap，保留最近2个版本
#>
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

if (-not [System.IO.Path]::IsPathRooted($Dist)) {
    $Dist = Join-Path (Get-Location).Path $Dist
}
$Dist = (Resolve-Path -LiteralPath $Dist).Path

if (-not $Pub) {
    $Pub = Join-Path (Split-Path -Parent $PSCommandPath) "..\protect\verify-pub.json"
}
$Pub = [System.IO.Path]::GetFullPath($Pub)

$KeyId    = $env:COS_SECRET_ID
$KeySecret = $env:COS_SECRET_KEY

if (-not $DryRun) {
    if (-not $KeyId -or -not $KeySecret) {
        throw "缺少 COS_SECRET_ID / COS_SECRET_KEY 环境变量（GitHub Actions 里由 Secrets 注入）"
    }
}

if (-not $Coscli) {
    $cmd = Get-Command coscli -ErrorAction SilentlyContinue
    if ($cmd) { $Coscli = $cmd.Source }
}
if (-not $Coscli -and -not $DryRun) { throw "找不到 coscli，请用 -Coscli 指定 coscli.exe 路径" }
if ($Coscli) {
    if (-not (Test-Path -LiteralPath $Coscli)) { throw "coscli 不存在：$Coscli" }
    $Coscli = (Resolve-Path -LiteralPath $Coscli).Path
}

$cfgPath = Join-Path $env:TEMP ("cos-" + [guid]::NewGuid().ToString("N") + ".config.yaml")
if (-not $DryRun) {
    @"
cos:
  base:
    secretid: $KeyId
    secretkey: $KeySecret
    protocol: https
"@ | Set-Content -LiteralPath $cfgPath -Encoding utf8
}

$Endpoint = "cos.$Region.myqcloud.com"
$CosArgs = @("-c", $cfgPath, "-e", $Endpoint)
$staticBase = "https://$Bucket.cos-website.$Region.myqcloud.com/$Prefix"

function Get-Sha256([string] $File) {
    return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

# 简易带重试下载函数，用于拉yml/sig
function Invoke-WebRequest-Retry {
    param($Uri,$OutFile,$MaxRetry=3)
    for($i=0;$i -lt $MaxRetry;$i++){
        try{
            Invoke-WebRequest -Uri $Uri -OutFile $OutFile -TimeoutSec 90 -UseBasicParsing
            return
        }catch{
            if($i -eq $MaxRetry-1){throw $_}
            Write-Host "[push-cos] yml/sig下载重试 $($i+1)/$MaxRetry"
            Start-Sleep -Seconds 3
        }
    }
}

$Prefix = $Prefix.Trim("/")
$CosBase = "cos://$Bucket/$Prefix"

$installers = @(Get-ChildItem -LiteralPath $Dist -File |
    Where-Object { $_.Name -match '\.(exe|msi|dmg|zip|AppImage)$' })
$blockmaps = @(Get-ChildItem -LiteralPath $Dist -File -Filter "*.blockmap")
$yml = Join-Path $Dist "latest.yml"
$sig = Join-Path $Dist "latest.yml.sig"

if ($installers.Count -eq 0) { throw "在 $Dist 里没找到安装包（electron-builder 产物应为 .exe）" }
if (-not (Test-Path -LiteralPath $yml)) { throw "缺少 latest.yml，先跑 electron-builder 和 sign-update.js" }
if (-not (Test-Path -LiteralPath $sig)) { throw "缺少 latest.yml.sig，先跑 node scripts/sign-update.js" }

# 上传前本地预验签
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
    Write-Host ("[push-cos] {0} -> {1} ({2:N0} bytes, sha256 local {3})" -f $item.Name, $remote, $size, $hash.Substring(0, 16))
    if ($DryRun) { continue }
    $meta = "Cache-Control:$($item.Cache)"
    & $Coscli cp $item.File $remote @CosArgs --meta $meta
    if ($LASTEXITCODE -ne 0) { throw "上传失败：$($item.Name)" }
    Write-Host "[push-cos]   上传成功，跳过大包回读校验（静态桶HEAD403兼容）"
}

if (-not $DryRun) {
    # 安全底线：静态域名GET下载yml/sig验签，不再用coscli cp
    $tmpYml = Join-Path $env:TEMP ("cosyml-" + [guid]::NewGuid().ToString("N") + ".yml")
    $tmpSig = Join-Path $env:TEMP ("cosyml-" + [guid]::NewGuid().ToString("N") + ".sig")
    try {
        $urlYml = "$staticBase/latest.yml"
        $urlSig = "$staticBase/latest.yml.sig"
        Invoke-WebRequest-Retry -Uri $urlYml -OutFile $tmpYml
        Invoke-WebRequest-Retry -Uri $urlSig -OutFile $tmpSig
        node (Join-Path (Split-Path -Parent $PSCommandPath) "verify-update-sig.js") --yml $tmpYml --sig $tmpSig --pub $Pub
        if ($LASTEXITCODE -ne 0) { throw "线上清单验签失败" }
    } finally {
        foreach ($t in @($tmpYml, $tmpSig)) { if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force } }
    }

    Write-Host "[push-cos] 全部完成：$CosBase"
    Write-Host "[push-cos] 客户端更新源 = $staticBase/"

    # 成套清理旧exe+blockmap，保留最近2版本
    Write-Host "[push-cos] 开始处理历史安装包与差分文件"
    $rawLs = & $Coscli ls $CosBase @CosArgs --format json
    if ($LASTEXITCODE -eq 0) {
        $listAll = $rawLs | ConvertFrom-Json
        $verDict = @{}
        foreach ($obj in $listAll) {
            $k = $obj.key
            if ($k -match "^$Prefix/dickson-color-studio-Setup-(\d+\.\d+\.\d+)\.exe$") {
                $v = $matches[1]
                if(-not $verDict.ContainsKey($v)){$verDict[$v] = @()}
                $verDict[$v] += $k
            }
            elseif ($k -match "^$Prefix/dickson-color-studio-Setup-(\d+\.\d+\.\d+)\.exe\.blockmap$") {
                $v = $matches[1]
                if(-not $verDict.ContainsKey($v)){$verDict[$v] = @()}
                $verDict[$v] += $k
            }
        }
        $verList = $verDict.Keys | Sort-Object {[version]$_} -Descending
        $keepVer = $verList | Select-Object -First 2
        foreach ($v in $verList) {
            if ($keepVer -notcontains $v) {
                foreach ($delKey in $verDict[$v]) {
                    $shortName = Split-Path $delKey -Leaf
                    Write-Host "[push-cos] 删除过期版本文件 $delKey"
                    & $Coscli rm "$CosBase/$shortName" @CosArgs
                }
            }
        }
    }
}

if (-not $DryRun -and (Test-Path -LiteralPath $cfgPath)) {
    Remove-Item -LiteralPath $cfgPath -Force
}
