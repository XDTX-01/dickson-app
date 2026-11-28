// 原生保护模块（L3）：宿主校验 / 一次性会话 / fuse 线强制 / 调试器检测 / 到期判定 / 授权注入 / 完整性自检
// 编译产物：protect.node（必须从 asar 解包，见 package.json asarUnpack）
//
// 设计原则：
//   1) 判定逻辑只在这里，JS 侧看不到（反编译 JS 拿不到规则）
//   2) 到期/授权以 applyLicense() 的结果优先，编译期常量只作兜底
//   3) fuse 线从自身 exe 里读，读了就是“这份二进制到底是什么配置”
#include <napi.h>

#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace {

// 授权到期兜底时间：唯一定义处。只对“没有签名授权”的机器生效
// 1798761599000 = 2026-12-31 23:59:59 UTC = 2027-01-01 07:59:59 CST
constexpr int64_t EXPIRE_MS = 1798761599000LL;

// 应用只允许以自己的可执行文件名启动（换个名字跑 = 不是我们发出去的那份）
const char* EXE_NAME = "dickson-color-studio.exe";

// Electron fuse wire 的固定哨兵（32 字节），fuse 数据紧跟在它后面
const char* FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";

// fuse 顺序（Electron 45）：
// 0 RunAsNode, 1 CookieEncryption, 2 NodeOptions, 3 CliInspect, 4 AsarIntegrity,
// 5 OnlyLoadAppFromAsar, 6 V8Snapshot, 7 FileProtocolPrivileges, 8 WasmTrapHandlers
const int IDX_RUN_AS_NODE = 0;
const int IDX_NODE_OPTIONS = 2;
const int IDX_CLI_INSPECT = 3;
const int IDX_ONLY_LOAD_ASAR = 5;

const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

inline uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

class Sha256 {
  public:
    Sha256() { reset(); }
    void reset() {
        h_[0] = 0x6a09e667; h_[1] = 0xbb67ae85; h_[2] = 0x3c6ef372; h_[3] = 0xa54ff53a;
        h_[4] = 0x510e527f; h_[5] = 0x9b05688c; h_[6] = 0x1f83d9ab; h_[7] = 0x5be0cd19;
        bit_len_ = 0;
        std::memset(buf_, 0, 64);
        buf_pos_ = 0;
    }
    void update(const uint8_t* data, size_t len) {
        for (size_t i = 0; i < len; ++i) {
            buf_[buf_pos_++] = data[i];
            bit_len_ += 8;
            if (buf_pos_ == 64) { block(buf_); buf_pos_ = 0; }
        }
    }
    std::string finalHex() {
        uint64_t bits = bit_len_;
        uint8_t pad = 0x80;
        update(&pad, 1);
        pad = 0;
        while (buf_pos_ != 56) update(&pad, 1);
        uint8_t len[8];
        for (int i = 0; i < 8; ++i) len[i] = (bits >> (56 - 8 * i)) & 0xff;
        update(len, 8);
        std::ostringstream os;
        os << std::hex << std::setfill('0');
        for (int i = 0; i < 8; ++i) os << std::setw(8) << h_[i];
        return os.str();
    }
  private:
    void block(const uint8_t* p) {
        uint32_t w[64];
        for (int i = 0; i < 16; ++i)
            w[i] = (uint32_t)p[4*i] << 24 | (uint32_t)p[4*i+1] << 16 |
                   (uint32_t)p[4*i+2] << 8 | (uint32_t)p[4*i+3];
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >> 3);
            uint32_t s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3],
                 e = h_[4], f = h_[5], g = h_[6], h = h_[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = h + S1 + ch + K[i] + w[i];
            uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = S0 + maj;
            h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h_[0]+=a; h_[1]+=b; h_[2]+=c; h_[3]+=d; h_[4]+=e; h_[5]+=f; h_[6]+=g; h_[7]+=h;
    }
    uint32_t h_[8];
    uint64_t bit_len_ = 0;
    uint8_t buf_[64];
    size_t buf_pos_ = 0;
};

std::string sha256String(const std::string& text) {
    Sha256 h;
    h.update(reinterpret_cast<const uint8_t*>(text.data()), text.size());
    return h.finalHex();
}

std::string sha256File(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return "";
    Sha256 h;
    char chunk[8192];
    while (f) {
        f.read(chunk, sizeof(chunk));
        std::streamsize n = f.gcount();
        if (n > 0) h.update(reinterpret_cast<const uint8_t*>(chunk), static_cast<size_t>(n));
    }
    return h.finalHex();
}

int64_t nowMs() {
    auto now = std::chrono::system_clock::now();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
}

std::string toLowerAscii(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

#ifdef _WIN32
std::string utf8FromWide(const wchar_t* wide) {
    if (!wide) return "";
    int need = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
    if (need <= 1) return "";
    std::string out(static_cast<size_t>(need - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), need, nullptr, nullptr);
    return out;
}

std::string currentExePath() {
    wchar_t buf[32768];
    DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(sizeof(buf) / sizeof(buf[0])));
    if (n == 0 || n >= sizeof(buf) / sizeof(buf[0])) return "";
    return utf8FromWide(buf);
}

bool debuggerAttached() {
    if (IsDebuggerPresent()) return true;
    BOOL remote = FALSE;
    if (CheckRemoteDebuggerPresent(GetCurrentProcess(), &remote) && remote) return true;
    return false;
}
#else
std::string currentExePath() { return ""; }
bool debuggerAttached() { return false; }
#endif

// 会话状态：openCore 一次成功之后才允许调用其它导出
bool g_coreOpen = false;
std::string g_sessionToken;
int64_t g_openedAt = 0;

// 授权状态：applyLicense 注入的到期时间优先于编译期常量
int64_t g_licenseMs = 0;
bool g_licenseApplied = false;

// 自身 exe 里 fuse 线的读取结果（启动期一次性判定，缓存起来避免反复读大文件）
bool g_fuseChecked = false;
bool g_fuseOk = false;
std::string g_fuseReason;
std::string g_fuseWire;

// 读自身镜像里的 fuse wire：32 字节哨兵 + 版本字节 + 数量字节 + N 个 '0'/'1'
bool readFuseWire(std::string* wire, std::string* reason) {
#ifdef _WIN32
    const std::string exe = currentExePath();
    if (exe.empty()) { *reason = "拿不到自身 exe 路径"; return false; }
    std::ifstream f(exe, std::ios::binary);
    if (!f) { *reason = "自身 exe 无法打开"; return false; }

    std::vector<uint8_t> buf(64 * 1024 + 64);
    size_t carry = 0;
    bool found = false;
    while (f) {
        f.read(reinterpret_cast<char*>(buf.data() + carry),
               static_cast<std::streamsize>(buf.size() - carry));
        std::streamsize n = f.gcount();
        size_t total = carry + static_cast<size_t>(n > 0 ? n : 0);
        if (total > 34) {
            for (size_t i = 0; i + 34 <= total; ++i) {
                if (std::memcmp(buf.data() + i, FUSE_SENTINEL, 32) != 0) continue;
                const uint8_t* p = buf.data() + i + 32;
                const unsigned version = p[0];
                const unsigned count = p[1];
                if (count < 9 || count > 32) {
                    *reason = "fuse 数量异常: " + std::to_string(count);
                    return false;
                }
                if (i + 34 + count > total) {
                    *reason = "fuse 数据被截断";
                    return false;
                }
                std::string bits;
                for (unsigned k = 0; k < count; ++k) {
                    const uint8_t b = p[2 + k];
                    if (b != '0' && b != '1') { *reason = "fuse 位不是 0/1"; return false; }
                    bits.push_back(static_cast<char>(b));
                }
                *wire = "v" + std::to_string(version) + ":" + bits;
                found = true;
                break;
            }
        }
        if (found) break;
        // 保留尾部 34 字节，防止哨兵被切在两次 read 之间
        carry = total > 34 ? 34 : total;
        if (carry) std::memmove(buf.data(), buf.data() + total - carry, carry);
        if (n <= 0) break;
    }
    if (!found) { *reason = "自身镜像里找不到 fuse 哨兵"; return false; }
    return true;
#else
    *reason = "非 Windows 平台不校验 fuse";
    return false;
#endif
}

// 只查安全相关的四个位，其余交给 Electron 自己
bool validateFuseWire(const std::string& wire, std::string* reason) {
    const size_t sep = wire.find(':');
    if (sep == std::string::npos) { *reason = "fuse 格式异常"; return false; }
    const std::string bits = wire.substr(sep + 1);
    if (bits.size() < 9) { *reason = "fuse 位数不足"; return false; }

    auto bit = [&](int idx) -> char { return bits[static_cast<size_t>(idx)]; };

    if (bit(IDX_RUN_AS_NODE) != '0') { *reason = "RunAsNode 未关闭（可用 ELECTRON_RUN_AS_NODE 绕过校验）"; return false; }
    if (bit(IDX_NODE_OPTIONS) != '0') { *reason = "NodeOptions 环境变量未关闭"; return false; }
    if (bit(IDX_CLI_INSPECT) != '0') { *reason = "CliInspect 未关闭（--inspect 可调试）"; return false; }
    if (bit(IDX_ONLY_LOAD_ASAR) != '1') { *reason = "OnlyLoadAppFromAsar 未开启（可加载外部 app 目录）"; return false; }
    return true;
}

bool ensureFuseChecked(std::string* reason) {
    if (g_fuseChecked) {
        if (reason) *reason = g_fuseReason;
        return g_fuseOk;
    }
    g_fuseChecked = true;
    std::string wire;
    std::string why;
    if (!readFuseWire(&wire, &why)) {
        g_fuseOk = false;
        g_fuseReason = why;
        if (reason) *reason = why;
        return false;
    }
    g_fuseWire = wire;
    if (!validateFuseWire(wire, &why)) {
        g_fuseOk = false;
        g_fuseReason = why;
        if (reason) *reason = why;
        return false;
    }
    g_fuseOk = true;
    g_fuseReason.clear();
    if (reason) reason->clear();
    return true;
}

// 宿主校验：exe 文件名必须是发行名 + fuse 线必须是加固后的值
bool hostValid(std::string* reason) {
#ifdef _WIN32
    const std::string exe = currentExePath();
    if (exe.empty()) { *reason = "拿不到自身 exe 路径"; return false; }
    std::string base = exe;
    const size_t slash = base.find_last_of("\\/");
    if (slash != std::string::npos) base = base.substr(slash + 1);
    if (toLowerAscii(base) != std::string(EXE_NAME)) {
        *reason = "可执行文件名不是发行名: " + base;
        return false;
    }
#endif
    return ensureFuseChecked(reason);
}

// 机器码：Windows 读 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid，
// 取 sha256("dickson-mid:"+guid) 的前 32 位十六进制；其它平台用主机名
std::string computeMachineId() {
#ifdef _WIN32
    wchar_t guid[512];
    DWORD size = static_cast<DWORD>(sizeof(guid));
    DWORD type = 0;
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Cryptography",
                     L"MachineGuid", RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
                     &type, guid, &size) != ERROR_SUCCESS) {
        return std::string();
    }
    const std::string plain = utf8FromWide(guid);
    if (plain.empty()) return std::string();
    return sha256String("dickson-mid:" + plain).substr(0, 32);
#else
    char host[256];
    if (gethostname(host, sizeof(host)) != 0) return std::string();
    return sha256String(std::string("dickson-mid:") + host).substr(0, 32);
#endif
}

}  // namespace

// openCore(seed) -> 会话令牌字符串；失败返回空串
// 一次性：同一进程内只允许成功一次，重复调用不会刷新令牌
Napi::Value OpenCore(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_coreOpen) return Napi::String::New(env, g_sessionToken);
    if (info.Length() < 1 || !info[0].IsString()) return Napi::String::New(env, "");

    const std::string seed = info[0].As<Napi::String>().Utf8Value();
    if (seed.size() < 16) return Napi::String::New(env, "");

    std::string reason;
    if (!hostValid(&reason)) return Napi::String::New(env, "");

    g_openedAt = nowMs();
    g_sessionToken = sha256String("sid:" + seed + ":" + std::to_string(g_openedAt) + ":" +
                                  std::to_string(EXPIRE_MS))
                         .substr(0, 48);
    g_coreOpen = true;
    return Napi::String::New(env, g_sessionToken);
}

Napi::Value IsCoreOpen(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_coreOpen);
}

// hostCheck() -> { ok, reason, debugger, fuse }
Napi::Value HostCheck(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object out = Napi::Object::New(env);
    std::string reason;
    const bool ok = hostValid(&reason);
    out.Set("ok", Napi::Boolean::New(env, ok));
    out.Set("reason", Napi::String::New(env, ok ? "" : reason));
    out.Set("debugger", Napi::Boolean::New(env, debuggerAttached()));
    out.Set("fuse", Napi::String::New(env, g_fuseWire));
    return out;
}

// checkTamper() -> { ok, debugger, reason }：运行期随时可调，不依赖会话
Napi::Value CheckTamper(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object out = Napi::Object::New(env);
    const bool dbg = debuggerAttached();
    out.Set("ok", Napi::Boolean::New(env, !dbg));
    out.Set("debugger", Napi::Boolean::New(env, dbg));
    out.Set("reason", Napi::String::New(env, dbg ? "检测到调试器" : ""));
    return out;
}

// 过期判定：0=有效，1=已过期（有签名授权时以授权到期时间为准）
Napi::Value CheckExpiry(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!g_coreOpen) {
        Napi::Error::New(env, "protect: 会话未打开，拒绝调用 checkExpiry").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int64_t deadline = g_licenseApplied ? g_licenseMs : EXPIRE_MS;
    const int64_t now = nowMs();
    return Napi::Number::New(env, now > deadline ? 1 : 0);
}

// 当前生效的到期时间戳（毫秒）
Napi::Value ExpireAt(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!g_coreOpen) {
        Napi::Error::New(env, "protect: 会话未打开，拒绝调用 expireAt").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Number::New(env, static_cast<double>(g_licenseApplied ? g_licenseMs : EXPIRE_MS));
}

// applyLicense(expireAtMs) -> true
Napi::Value ApplyLicense(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!g_coreOpen) {
        Napi::Error::New(env, "protect: 会话未打开，拒绝调用 applyLicense").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    if (info.Length() < 1 || !info[0].IsNumber()) return Napi::Boolean::New(env, false);
    const double ms = info[0].As<Napi::Number>().DoubleValue();
    if (!(ms > 0) || ms > 1e15) return Napi::Boolean::New(env, false);
    g_licenseMs = static_cast<int64_t>(ms);
    g_licenseApplied = true;
    return Napi::Boolean::New(env, true);
}

Napi::Value HasLicense(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!g_coreOpen) {
        Napi::Error::New(env, "protect: 会话未打开，拒绝调用 hasLicense").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Boolean::New(env, g_licenseApplied);
}

Napi::Value MachineId(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!g_coreOpen) {
        Napi::Error::New(env, "protect: 会话未打开，拒绝调用 machineId").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::String::New(env, computeMachineId());
}

// 文件完整性自检：路径 + 期望 sha256 十六进制
Napi::Value VerifyFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        return Napi::Boolean::New(env, false);
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    std::string expected = toLowerAscii(info[1].As<Napi::String>().Utf8Value());
    std::string actual = sha256File(filePath);
    if (actual.empty()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, actual == expected);
}

// 内存内容自检：Buffer + 期望 sha256 十六进制（asar 里的文件用这个）
Napi::Value VerifyBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsString()) {
        return Napi::Boolean::New(env, false);
    }
    Napi::Buffer<uint8_t> data = info[0].As<Napi::Buffer<uint8_t>>();
    std::string expected = toLowerAscii(info[1].As<Napi::String>().Utf8Value());
    Sha256 h;
    h.update(data.Data(), data.Length());
    return Napi::Boolean::New(env, h.finalHex() == expected);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("openCore", Napi::Function::New(env, OpenCore));
    exports.Set("isCoreOpen", Napi::Function::New(env, IsCoreOpen));
    exports.Set("hostCheck", Napi::Function::New(env, HostCheck));
    exports.Set("checkTamper", Napi::Function::New(env, CheckTamper));
    exports.Set("checkExpiry", Napi::Function::New(env, CheckExpiry));
    exports.Set("expireAt", Napi::Function::New(env, ExpireAt));
    exports.Set("applyLicense", Napi::Function::New(env, ApplyLicense));
    exports.Set("hasLicense", Napi::Function::New(env, HasLicense));
    exports.Set("machineId", Napi::Function::New(env, MachineId));
    exports.Set("verifyFile", Napi::Function::New(env, VerifyFile));
    exports.Set("verifyBuffer", Napi::Function::New(env, VerifyBuffer));
    return exports;
}

NODE_API_MODULE(protect, Init)
