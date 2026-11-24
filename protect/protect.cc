// 原生保护模块：过期判定 + 文件完整性自检
// 编译产物：protect.node（必须从 asar 解包，见 package.json asarUnpack）
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

// ---------------- 公共领域风格 SHA256（零外部依赖） ----------------
namespace {

// 授权到期时间：唯一定义处。1798761599000 = 2026-12-31 23:59:59 UTC
// 主进程只通过 expireAt() 读这个值，JS 里不再保留第二份常量
constexpr int64_t EXPIRE_MS = 1798761599000LL;

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

}  // namespace

// 过期判定：无参数；返回 0=有效，1=已过期
Napi::Value CheckExpiry(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto now = std::chrono::system_clock::now();
    auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                     now.time_since_epoch()).count();
    return Napi::Number::New(env, nowMs > EXPIRE_MS ? 1 : 0);
}

// 授权到期时间戳（毫秒）。0 表示没有到期时间
Napi::Value ExpireAt(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(EXPIRE_MS));
}

// 文件完整性自检：参数为文件路径、期望的 sha256 十六进制；返回 true=一致
Napi::Value VerifyFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        return Napi::Boolean::New(env, false);
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    std::string expected = info[1].As<Napi::String>().Utf8Value();
    std::string actual = sha256File(filePath);
    if (actual.empty()) return Napi::Boolean::New(env, false);
    for (char& c : expected) c = static_cast<char>(std::tolower(c));
    return Napi::Boolean::New(env, actual == expected);
}

// 内存内容自检：参数为 Buffer、期望的 sha256 十六进制；返回 true=一致
// 打包后关键文件都在 asar 里，ifstream 读不到，所以由 JS 读出内容、这里只负责算哈希
Napi::Value VerifyBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsString()) {
        return Napi::Boolean::New(env, false);
    }
    Napi::Buffer<uint8_t> data = info[0].As<Napi::Buffer<uint8_t>>();
    std::string expected = info[1].As<Napi::String>().Utf8Value();
    Sha256 h;
    h.update(data.Data(), data.Length());
    std::string actual = h.finalHex();
    for (char& c : expected) c = static_cast<char>(std::tolower(c));
    return Napi::Boolean::New(env, actual == expected);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("checkExpiry", Napi::Function::New(env, CheckExpiry));
    exports.Set("expireAt", Napi::Function::New(env, ExpireAt));
    exports.Set("verifyFile", Napi::Function::New(env, VerifyFile));
    exports.Set("verifyBuffer", Napi::Function::New(env, VerifyBuffer));
    return exports;
}

NODE_API_MODULE(protect, Init)
