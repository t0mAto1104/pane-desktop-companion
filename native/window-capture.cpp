#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <wincodec.h>
#include <commctrl.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <atomic>
#include <memory>
#include <chrono>
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;

struct Failure : std::runtime_error { using runtime_error::runtime_error; };

struct WindowInfo {
    HWND hwnd;
    DWORD pid;
    uint64_t started;
    std::wstring title;
    std::wstring executable;
    std::vector<std::wstring> applications;
};

struct UniqueHandle {
    HANDLE value;
    ~UniqueHandle() { if (value) CloseHandle(value); }
};

std::wstring processName(DWORD pid, uint64_t* started = nullptr) {
    UniqueHandle process{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)};
    if (!process.value) return {};
    wchar_t path[32768];
    DWORD size = static_cast<DWORD>(std::size(path));
    if (!QueryFullProcessImageNameW(process.value, 0, path, &size)) return {};
    if (started) {
        FILETIME creation, exitTime, kernel, user;
        if (!GetProcessTimes(process.value, &creation, &exitTime, &kernel, &user)) return {};
        *started = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
    }
    const std::wstring full(path, size);
    return full.substr(full.find_last_of(L"\\") + 1);
}

bool sameName(const std::wstring& a, const std::wstring& b) {
    return _wcsicmp(a.c_str(), b.c_str()) == 0;
}

std::optional<WindowInfo> inspect(HWND hwnd, DWORD assistant, const std::vector<std::wstring>& denied) {
    if (!hwnd || !IsWindowVisible(hwnd) || hwnd == GetShellWindow() || hwnd == GetDesktopWindow()) return {};
    DWORD pid = 0;
    if (!GetWindowThreadProcessId(hwnd, &pid) || pid == assistant) return {};
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) return {};
    if (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return {};
    wchar_t title[1024] = {};
    if (!GetWindowTextW(hwnd, title, static_cast<int>(std::size(title)))) return {};
    WindowInfo info{hwnd, pid, 0, title, {}, {}};
    auto owner = processName(pid, &info.started);
    if (owner.empty()) throw Failure("process_unavailable");
    info.executable = owner;
    info.applications.push_back(owner);
    if (sameName(owner, L"ApplicationFrameHost.exe")) {
        bool resolved = false;
        EnumChildWindows(hwnd, [](HWND child, LPARAM param) -> BOOL {
            auto& window = *reinterpret_cast<WindowInfo*>(param);
            DWORD childPid = 0;
            GetWindowThreadProcessId(child, &childPid);
            if (childPid && childPid != window.pid) {
                auto name = processName(childPid);
                if (name.empty()) window.applications.push_back(L"");
                else {
                    window.executable = name;
                    window.applications.push_back(std::move(name));
                }
            }
            return TRUE;
        }, reinterpret_cast<LPARAM>(&info));
        resolved = !sameName(info.executable, owner);
        if (!resolved) throw Failure("process_unavailable");
    }
    for (const auto& name : info.applications) {
        if (name.empty()) throw Failure("process_unavailable");
        if (std::any_of(denied.begin(), denied.end(), [&](const auto& item) { return sameName(name, item); }))
            throw Failure("blocked");
    }
    return info;
}

std::wstring windowId(const WindowInfo& window) {
    return std::to_wstring(reinterpret_cast<uintptr_t>(window.hwnd)) + L":" +
           std::to_wstring(window.pid) + L":" + std::to_wstring(window.started);
}

std::wstring quoted(const std::wstring& value) {
    std::wstringstream result;
    result << L'"';
    for (wchar_t ch : value) {
        if (ch == L'"' || ch == L'\\') result << L'\\' << ch;
        else if (ch < 32) {
            wchar_t code[7] = {};
            swprintf_s(code, L"\\u%04x", static_cast<unsigned int>(ch));
            result << code;
        } else result << ch;
    }
    result << L'"';
    return result.str();
}

std::wstring json(const WindowInfo& window) {
    return L"{\"id\":" + quoted(windowId(window)) + L",\"title\":" + quoted(window.title) +
           L",\"executable\":" + quoted(window.executable) + L"}";
}

void printJson(const std::wstring& data) {
    int bytes = WideCharToMultiByte(CP_UTF8, 0, data.data(), static_cast<int>(data.size()), nullptr, 0, nullptr, nullptr);
    std::string utf8(bytes, '\0');
    WideCharToMultiByte(CP_UTF8, 0, data.data(), static_cast<int>(data.size()), utf8.data(), bytes, nullptr, nullptr);
    std::cout << utf8 << '\n';
}

std::vector<uint8_t> encodeJpeg(UINT width, UINT height, UINT stride, BYTE* pixels, UINT bytes) {
    com_ptr<IWICImagingFactory> factory;
    check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())));
    com_ptr<IWICBitmap> bitmap;
    check_hresult(factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGRA, stride, bytes, pixels, bitmap.put()));

    com_ptr<IWICBitmapSource> source = bitmap.as<IWICBitmapSource>();
    const auto longest = std::max(width, height);
    if (longest > 2048) {
        com_ptr<IWICBitmapScaler> scaler;
        check_hresult(factory->CreateBitmapScaler(scaler.put()));
        check_hresult(scaler->Initialize(source.get(), std::max(1u, width * 2048 / longest),
            std::max(1u, height * 2048 / longest), WICBitmapInterpolationModeFant));
        source = scaler.as<IWICBitmapSource>();
    }
    com_ptr<IWICFormatConverter> converter;
    check_hresult(factory->CreateFormatConverter(converter.put()));
    check_hresult(converter->Initialize(source.get(), GUID_WICPixelFormat24bppBGR,
        WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));

    com_ptr<IStream> stream;
    check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
    com_ptr<IWICBitmapEncoder> encoder;
    check_hresult(factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.put()));
    check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
    com_ptr<IWICBitmapFrameEncode> frame;
    com_ptr<IPropertyBag2> options;
    check_hresult(encoder->CreateNewFrame(frame.put(), options.put()));
    wchar_t qualityName[] = L"ImageQuality";
    PROPBAG2 property{};
    property.pstrName = qualityName;
    VARIANT quality{};
    quality.vt = VT_R4;
    quality.fltVal = 0.92f;
    check_hresult(options->Write(1, &property, &quality));
    check_hresult(frame->Initialize(options.get()));
    check_hresult(converter->GetSize(&width, &height));
    check_hresult(frame->SetSize(width, height));
    auto format = GUID_WICPixelFormat24bppBGR;
    check_hresult(frame->SetPixelFormat(&format));
    check_hresult(frame->WriteSource(converter.get(), nullptr));
    check_hresult(frame->Commit());
    check_hresult(encoder->Commit());

    STATSTG stat{};
    check_hresult(stream->Stat(&stat, STATFLAG_NONAME));
    if (stat.cbSize.QuadPart > 12 * 1024 * 1024) throw Failure("image_too_large");
    check_hresult(stream->Seek({}, STREAM_SEEK_SET, nullptr));
    std::vector<uint8_t> result(static_cast<size_t>(stat.cbSize.QuadPart));
    ULONG read = 0;
    check_hresult(stream->Read(result.data(), static_cast<ULONG>(result.size()), &read));
    if (read != result.size() || result.empty()) throw Failure("encode_failed");
    return result;
}

constexpr UINT SampleWidth = 96;
constexpr UINT SampleHeight = 54;
constexpr auto CaptureFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;

void validateSize(winrt::Windows::Graphics::SizeInt32 size) {
    if (size.Width < 1 || size.Height < 1 || size.Width > 8192 || size.Height > 8192 ||
        static_cast<uint64_t>(size.Width) * size.Height > 40'000'000) throw Failure("invalid_size");
}

class WindowCapture {
public:
    explicit WindowCapture(HWND hwnd, bool monitoring = false) : monitoring(monitoring) {
        if (!GraphicsCaptureSession::IsSupported()) throw Failure("unsupported");
        auto item = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
        check_hresult(item->CreateForWindow(hwnd, guid_of<GraphicsCaptureItem>(), put_abi(target)));
        target.Closed([closed = closed](auto const&, auto const&) { closed->store(true); });

        HRESULT created = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put());
        if (FAILED(created)) {
            device = nullptr;
            context = nullptr;
            check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
        }
        com_ptr<IInspectable> inspectable;
        check_hresult(CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), inspectable.put()));
        graphics = inspectable.as<Direct3D11::IDirect3DDevice>();
        poolSize = target.Size();
        validateSize(poolSize);
        startFrames();
    }

    void ensureOpen() const {
        if (closed->load()) throw Failure("target_gone");
    }

    // For a static window WGC may produce no additional frames; retain the last sample.
    bool readLatest() {
        using Clock = std::chrono::steady_clock;
        const auto deadline = Clock::now() + std::chrono::seconds(2);
        auto retryAt = Clock::time_point::max();
        bool restarted = false;
        do {
            ensureOpen();
            auto frame = pool.TryGetNextFrame();
            if (!frame) {
                if (staging) return false;
                if (!restarted && Clock::now() >= retryAt) {
                    // A static resized window can stop delivering frames to a recreated pool.
                    // Start a fresh session once, retaining the same D3D device.
                    startFrames();
                    restarted = true;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(15));
                continue;
            }
            for (int i = 0; i < 3; ++i) {
                auto next = pool.TryGetNextFrame();
                if (!next) break;
                frame.Close();
                frame = std::move(next);
            }

            const auto size = frame.ContentSize();
            validateSize(size);
            if (size.Width != poolSize.Width || size.Height != poolSize.Height) {
                frame.Close();
                staging = nullptr;
                pool.Recreate(graphics, CaptureFormat, 2, size);
                poolSize = size;
                retryAt = Clock::now() + std::chrono::milliseconds(350);
                continue;
            }

            auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
            com_ptr<ID3D11Texture2D> texture;
            check_hresult(access->GetInterface(IID_PPV_ARGS(texture.put())));
            D3D11_TEXTURE2D_DESC desc{};
            texture->GetDesc(&desc);
            if (static_cast<UINT>(size.Width) > desc.Width || static_cast<UINT>(size.Height) > desc.Height)
                throw Failure("resized");
            if (!staging) {
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.MiscFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                check_hresult(device->CreateTexture2D(&desc, nullptr, staging.put()));
            }
            context->CopyResource(staging.get(), texture.get());
            frame.Close();
            return true;
        } while (std::chrono::steady_clock::now() < deadline);
        throw Failure("no_frame");
    }

    UINT width() const { return static_cast<UINT>(poolSize.Width); }
    UINT height() const { return static_cast<UINT>(poolSize.Height); }

    std::vector<uint8_t> jpeg() {
        return readPixels([&](BYTE* data, UINT stride) {
            return encodeJpeg(width(), height(), stride, data, stride * height());
        });
    }

    std::vector<uint8_t> sample() {
        return readPixels([&](BYTE* data, UINT stride) {
            std::vector<uint8_t> sample(SampleWidth * SampleHeight * 3);
            constexpr UINT taps = 4;
            for (UINT y = 0; y < SampleHeight; ++y) {
                for (UINT x = 0; x < SampleWidth; ++x) {
                    unsigned sum[3] = {};
                    for (UINT dy = 0; dy < taps; ++dy) {
                        const auto sy = ((y * taps + dy) * 2 + 1) * height() / (SampleHeight * taps * 2);
                        for (UINT dx = 0; dx < taps; ++dx) {
                            const auto sx = ((x * taps + dx) * 2 + 1) * width() / (SampleWidth * taps * 2);
                            const auto pixel = data + sy * stride + sx * 4;
                            for (UINT channel = 0; channel < 3; ++channel) sum[channel] += pixel[channel];
                        }
                    }
                    for (UINT c = 0; c < 3; ++c) sample[(y * SampleWidth + x) * 3 + c] =
                        static_cast<uint8_t>(sum[c] / (taps * taps));
                }
            }
            return sample;
        });
    }

private:
    void startFrames() {
        if (session) session.Close();
        if (pool) pool.Close();
        pool = Direct3D11CaptureFramePool::CreateFreeThreaded(graphics, CaptureFormat, 2, poolSize);
        session = pool.CreateCaptureSession(target);
        using winrt::Windows::Foundation::Metadata::ApiInformation;
        const auto captureClass = L"Windows.Graphics.Capture.GraphicsCaptureSession";
        if (ApiInformation::IsPropertyPresent(captureClass, L"IsCursorCaptureEnabled")) session.IsCursorCaptureEnabled(false);
        if (monitoring && ApiInformation::IsPropertyPresent(captureClass, L"MinUpdateInterval"))
            session.MinUpdateInterval(std::chrono::milliseconds(120));
        session.StartCapture();
    }
    template <typename Read>
    std::vector<uint8_t> readPixels(Read read) {
        if (!staging) throw Failure("no_frame");
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
        struct Unmap {
            ID3D11DeviceContext* context;
            ID3D11Texture2D* staging;
            ~Unmap() { context->Unmap(staging, 0); }
        } guard{context.get(), staging.get()};
        return read(static_cast<BYTE*>(mapped.pData), mapped.RowPitch);
    }

    const bool monitoring;
    GraphicsCaptureItem target{nullptr};
    com_ptr<ID3D11Device> device;
    com_ptr<ID3D11DeviceContext> context;
    com_ptr<ID3D11Texture2D> staging;
    Direct3D11::IDirect3DDevice graphics{nullptr};
    Direct3D11CaptureFramePool pool{nullptr};
    GraphicsCaptureSession session{nullptr};
    winrt::Windows::Graphics::SizeInt32 poolSize{};
    std::shared_ptr<std::atomic_bool> closed = std::make_shared<std::atomic_bool>(false);
};

bool activeDesktop() {
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    if (!desktop) return false;
    wchar_t input[256]{}, current[256]{};
    const bool available = GetUserObjectInformationW(desktop, UOI_NAME, input, sizeof(input), nullptr) &&
        GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, current, sizeof(current), nullptr);
    CloseDesktop(desktop);
    return available && sameName(input, current);
}

WindowInfo verifyWindow(HWND hwnd, const std::wstring& id, DWORD assistant, const std::vector<std::wstring>& denied,
                        const std::wstring& expectedExecutable = {}) {
    if (!activeDesktop()) throw Failure("desktop_locked");
    auto current = inspect(hwnd, assistant, denied);
    if (!current || windowId(*current) != id ||
        (!expectedExecutable.empty() && !sameName(current->executable, expectedExecutable))) throw Failure("target_gone");
    if (IsIconic(hwnd)) throw Failure("minimized");
    DWORD affinity = 0;
    if (GetWindowDisplayAffinity(hwnd, &affinity) && affinity != WDA_NONE) throw Failure("protected");
    return std::move(*current);
}

void writeBytes(const std::vector<uint8_t>& bytes) {
    if (!bytes.empty() && std::fwrite(bytes.data(), 1, bytes.size(), stdout) != bytes.size()) throw Failure("encode_failed");
    if (std::fflush(stdout) != 0) throw Failure("encode_failed");
}

void observe(HWND hwnd, const std::wstring& id, DWORD assistant, const std::vector<std::wstring>& denied,
             const std::wstring& executable) {
    WindowCapture capture(hwnd, true);
    std::vector<uint8_t> lowResolution;
    std::string command;
    while (std::getline(std::cin, command)) {
        verifyWindow(hwnd, id, assistant, denied, executable);
        capture.ensureOpen();
        std::vector<uint8_t> screenshot;
        if (command == "sample") {
            if (capture.readLatest() || lowResolution.empty()) lowResolution = capture.sample();
        } else if (command == "jpeg") {
            // The JPEG must represent the same pixels that were compared in the last sample.
            if (lowResolution.empty()) throw Failure("no_frame");
            screenshot = capture.jpeg();
        } else throw Failure("invalid_request");

        const auto current = verifyWindow(hwnd, id, assistant, denied, executable);
        capture.ensureOpen();
        const auto& payload = command == "sample" ? lowResolution : screenshot;
        const auto kind = command == "sample" ? L"sample" : L"jpeg";
        const auto dpi = GetDpiForWindow(hwnd);
        printJson(L"{\"kind\":\"" + std::wstring(kind) + L"\",\"bytes\":" + std::to_wstring(payload.size()) +
            L",\"width\":" + std::to_wstring(capture.width()) + L",\"height\":" + std::to_wstring(capture.height()) +
            L",\"dpi\":" + std::to_wstring(dpi) + L",\"target\":" + json(current) + L"}");
        writeBytes(payload);
    }
}


constexpr int KeyEditId = 110;
constexpr size_t KeyCapacity = 513;

INT_PTR CALLBACK credentialDialog(HWND dialog, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_INITDIALOG) {
        SetWindowLongPtrW(dialog, DWLP_USER, lparam);
        SetWindowTextW(dialog, L"Pane · OpenAI API Key");
        SetWindowDisplayAffinity(dialog, WDA_EXCLUDEFROMCAPTURE);
        UINT dpi = GetDpiForWindow(dialog);
        if (!dpi) dpi = 96;
        auto px = [dpi](int logical) { return MulDiv(logical, dpi, 96); };
        auto control = [&](DWORD ex, const wchar_t* type, const wchar_t* caption, DWORD style,
                           int x, int y, int width, int height, int id) {
            const HWND child = CreateWindowExW(ex, type, caption, WS_CHILD | WS_VISIBLE | style,
                px(x), px(y), px(width), px(height), dialog, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                GetModuleHandleW(nullptr), nullptr);
            if (child) SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
            return child;
        };
        control(0, L"STATIC", L"请输入 OpenAI API Key", 0, 15, 13, 315, 22, -1);
        HWND edit = control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_TABSTOP | ES_PASSWORD | ES_AUTOHSCROLL,
            15, 42, 315, 25, KeyEditId);
        HWND ok = control(0, L"BUTTON", L"保存", WS_TABSTOP | BS_DEFPUSHBUTTON, 171, 84, 74, 27, IDOK);
        HWND cancel = control(0, L"BUTTON", L"取消", WS_TABSTOP | BS_PUSHBUTTON, 256, 84, 74, 27, IDCANCEL);
        if (!edit || !ok || !cancel) { EndDialog(dialog, -1); return TRUE; }
        SendMessageW(edit, EM_SETLIMITTEXT, KeyCapacity - 1, 0);
        SendMessageW(dialog, DM_SETDEFID, IDOK, 0);
        RECT rectangle{0, 0, px(346), px(126)};
        AdjustWindowRectExForDpi(&rectangle,
            static_cast<DWORD>(GetWindowLongPtrW(dialog, GWL_STYLE)), FALSE,
            static_cast<DWORD>(GetWindowLongPtrW(dialog, GWL_EXSTYLE)), dpi);
        const auto parent = GetWindow(dialog, GW_OWNER);
        RECT host{};
        GetWindowRect(parent, &host);
        const int width = rectangle.right - rectangle.left;
        const int height = rectangle.bottom - rectangle.top;
        SetWindowPos(dialog, HWND_TOPMOST, host.left + (host.right - host.left - width) / 2,
            host.top + (host.bottom - host.top - height) / 2, width, height, SWP_SHOWWINDOW);
        SetFocus(edit);
        return FALSE;
    }
    if (message == WM_COMMAND && LOWORD(wparam) == IDOK) {
        auto key = reinterpret_cast<wchar_t*>(GetWindowLongPtrW(dialog, DWLP_USER));
        GetDlgItemTextW(dialog, KeyEditId, key, static_cast<int>(KeyCapacity));
        SetDlgItemTextW(dialog, KeyEditId, L"");
        EndDialog(dialog, IDOK);
        return TRUE;
    }
    if (message == WM_CLOSE || (message == WM_COMMAND && LOWORD(wparam) == IDCANCEL)) {
        EndDialog(dialog, IDCANCEL);
        return TRUE;
    }
    return FALSE;
}

void promptKey(HWND parent, DWORD owner) {
    DWORD pid = 0;
    GetWindowThreadProcessId(parent, &pid);
    if (pid != owner) throw Failure("invalid_request");
    struct EmptyDialog {
        DLGTEMPLATE layout;
        WORD menu;
        WORD windowClass;
        WORD title;
    };
    alignas(DWORD) EmptyDialog spec{};
    spec.layout.style = WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_MODALFRAME;
    spec.layout.dwExtendedStyle = WS_EX_DLGMODALFRAME;
    wchar_t key[KeyCapacity] = {};
    const auto result = DialogBoxIndirectParamW(GetModuleHandleW(nullptr), &spec.layout, parent,
        credentialDialog, reinterpret_cast<LPARAM>(key));
    if (result == IDOK) {
        char utf8[4 * KeyCapacity] = {};
        const auto written = WideCharToMultiByte(CP_UTF8, 0, key, -1, utf8, static_cast<int>(std::size(utf8)), nullptr, nullptr);
        if (written > 1) std::fwrite(utf8, 1, static_cast<size_t>(written - 1), stdout);
        SecureZeroMemory(utf8, sizeof(utf8));
    }
    SecureZeroMemory(key, sizeof(key));
    if (result == IDCANCEL) throw Failure("key_cancelled");
    if (result != IDOK) throw Failure("key_dialog_failed");
}

int wmain(int argc, wchar_t** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    try {
        if (argc < 3) throw Failure("invalid_request");
        const std::wstring command = argv[1];
        const auto assistant = std::stoul(argv[2]);
        const bool targetCommand = command == L"capture" || command == L"observe" || command == L"verify";
        if (targetCommand && argc < 4) throw Failure("invalid_request");
        int firstDenied = targetCommand ? 4 : 3;
        std::wstring expectedExecutable;
        if (targetCommand && argc > firstDenied && std::wstring_view(argv[firstDenied]) == L"--expected-executable") {
            if (argc <= firstDenied + 1) throw Failure("invalid_request");
            expectedExecutable = argv[firstDenied + 1];
            firstDenied += 2;
        }
        std::vector<std::wstring> denied;
        for (int index = firstDenied; index < argc; ++index) denied.emplace_back(argv[index]);

        if (command == L"credential" && argc == 4) { promptKey(reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(argv[3]))), assistant); } else if (command == L"foreground") {
            auto window = inspect(GetAncestor(GetForegroundWindow(), GA_ROOT), assistant, denied);
            if (!window) throw Failure("no_target");
            printJson(json(*window));
        } else if (command == L"list") {
            struct List { DWORD assistant; const std::vector<std::wstring>& denied; std::wstring data = L"["; };
            List list{assistant, denied};
            EnumWindows([](HWND hwnd, LPARAM param) -> BOOL {
                auto& list = *reinterpret_cast<List*>(param);
                try {
                    auto window = inspect(hwnd, list.assistant, list.denied);
                    if (!window) return TRUE;
                    if (list.data.size() > 1) list.data += L',';
                    list.data += json(*window);
                } catch (const Failure&) {}
                return list.data.size() < 130000;
            }, reinterpret_cast<LPARAM>(&list));
            printJson(list.data + L"]");
        } else if (targetCommand) {
            const std::wstring id = argv[3];
            const auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(id)));
            const auto current = verifyWindow(hwnd, id, assistant, denied, expectedExecutable);
            if (command == L"verify") {
                printJson(json(current));
                return 0;
            }
            init_apartment(apartment_type::multi_threaded);
            if (command == L"observe") {
                observe(hwnd, id, assistant, denied, current.executable);
            } else {
                WindowCapture capture(hwnd);
                capture.readLatest();
                const auto jpeg = capture.jpeg();
                const auto after = verifyWindow(hwnd, id, assistant, denied, current.executable);
                printJson(json(after));
                writeBytes(jpeg);
            }
        } else throw Failure("invalid_request");
        return 0;
    } catch (const Failure& error) {
        std::cerr << error.what();
    } catch (const hresult_error& error) {
        std::fprintf(stderr, "capture_hresult:%08X", static_cast<unsigned int>(error.code().value));
    } catch (...) {
        std::cerr << "invalid_request";
    }
    return 1;
}
