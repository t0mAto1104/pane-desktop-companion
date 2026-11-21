#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "text-selection.h"
#include <objbase.h>
#include <oleauto.h>
#include <UIAutomation.h>
#include <winrt/base.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cwctype>
#include <iomanip>
#include <sstream>
#include <string_view>

namespace {
using winrt::com_ptr;
struct Text {
    BSTR value{};
    ~Text() { SysFreeString(value); }
};
struct Array {
    SAFEARRAY* value{};
    ~Array() { if (value) SafeArrayDestroy(value); }
};
bool mayRead(IUIAutomationElement* element) {
    BOOL password = TRUE;
    return SUCCEEDED(element->get_CurrentIsPassword(&password)) && !password;
}
std::wstring quote(std::wstring_view text) {
    std::wstringstream out;
    out << L'"';
    for (wchar_t ch : text) {
        if (ch == L'"' || ch == L'\\') out << L'\\' << ch;
        else if (ch < 32) out << L"\\u" << std::hex << std::setfill(L'0') << std::setw(4) << static_cast<unsigned>(ch);
        else out << ch;
    }
    out << L'"';
    return out.str();
}
size_t characters(std::wstring_view text) {
    size_t count = 0;
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] >= 0xd800 && text[i] <= 0xdbff && i + 1 < text.size() && text[i + 1] >= 0xdc00 && text[i + 1] <= 0xdfff) ++i;
        ++count;
    }
    return count;
}
com_ptr<IUIAutomation> automation() {
    com_ptr<IUIAutomation> client;
    if (FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(client.put())))) return {};
    return client;
}
com_ptr<IUIAutomationTextPattern> patternFor(IUIAutomationElement* node) {
    com_ptr<IUIAutomationTextPattern> pattern;
    if (FAILED(node->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(pattern.put())))) return {};
    return pattern;
}
constexpr UINT selectEvent = WM_APP + 1;
constexpr UINT focusEvent = WM_APP + 2;
constexpr UINT pointerEvent = WM_APP + 3;
DWORD monitorThread{};
DWORD parentPid{};
POINT downAt{};
HWND downWindow{};
HWND foreground() { return GetAncestor(GetForegroundWindow(), GA_ROOT); }
LRESULT CALLBACK mouseHook(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION && (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP)) {
        auto& info = *reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
        if (!(info.flags & LLMHF_INJECTED)) {
            if (message == WM_LBUTTONDOWN) {
                downAt = info.pt;
                downWindow = foreground();
            } else {
                bool drag = downWindow && downWindow == foreground() &&
                    (std::abs(info.pt.x - downAt.x) >= 5 || std::abs(info.pt.y - downAt.y) >= 5);
                downWindow = nullptr;
                PostThreadMessageW(monitorThread, pointerEvent, drag ? 1 : 0, 0);
            }
        }
    }
    return CallNextHookEx(nullptr, code, message, data);
}
void CALLBACK foregroundHook(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD) {
    PostThreadMessageW(monitorThread, focusEvent, 0, 0);
}
struct SelectionEvents : winrt::implements<SelectionEvents, IUIAutomationEventHandler> {
    HRESULT STDMETHODCALLTYPE HandleAutomationEvent(IUIAutomationElement*, EVENTID) noexcept override {
        PostThreadMessageW(monitorThread, selectEvent, 0, 0);
        return S_OK;
    }
};
}

std::wstring selectedText(HWND window, const RECT& bounds) {
    auto client = automation();
    com_ptr<IUIAutomationElement> root, focus;
    com_ptr<IUIAutomationTreeWalker> walker;
    if (!client || FAILED(client->ElementFromHandle(window, root.put())) || !root ||
        FAILED(client->GetFocusedElement(focus.put())) || !focus ||
        FAILED(client->get_RawViewWalker(walker.put())) || !walker) return L"{\"status\":\"unsupported\"}";
    com_ptr<IUIAutomationTextPattern> pattern;
    auto element = focus;
    bool reachesWindow = false;
    for (int depth = 0; element && depth < 32; ++depth) {
        if (!mayRead(element.get())) return L"{\"status\":\"protected\"}";
        if (!pattern) pattern = patternFor(element.get());
        BOOL equal = FALSE;
        if (SUCCEEDED(client->CompareElements(element.get(), root.get(), &equal)) && equal) {
            reachesWindow = true;
            break;
        }
        com_ptr<IUIAutomationElement> parent;
        if (FAILED(walker->GetParentElement(element.get(), parent.put()))) break;
        element = std::move(parent);
    }
    if (!reachesWindow || !pattern) return L"{\"status\":\"unsupported\"}";
    com_ptr<IUIAutomationTextRangeArray> ranges;
    if (FAILED(pattern->GetSelection(ranges.put()))) return L"{\"status\":\"unsupported\"}";
    int count = 0;
    if (!ranges || FAILED(ranges->get_Length(&count)) || count < 1) return L"{\"status\":\"empty\"}";
    if (count > 8) return L"{\"status\":\"limit\"}";
    std::wstring text;
    std::wstringstream rectangles;
    int pieces = 0;
    for (int i = 0; i < count; ++i) {
        com_ptr<IUIAutomationTextRange> range;
        if (FAILED(ranges->GetElement(i, range.put())) || !range) return L"{\"status\":\"unsupported\"}";
        com_ptr<IUIAutomationElement> enclosing;
        if (FAILED(range->GetEnclosingElement(enclosing.put())) || !enclosing || !mayRead(enclosing.get()))
            return L"{\"status\":\"protected\"}";
        Text segment;
        if (FAILED(range->GetText(6001, &segment.value))) return L"{\"status\":\"unsupported\"}";
        const auto length = SysStringLen(segment.value);
        if (!length) continue;
        if (!text.empty()) text += L'\n';
        text.append(segment.value, length);
        if (characters(text) > 3000) return L"{\"status\":\"limit\"}";
        Array positions;
        LONG first{}, last{};
        if (FAILED(range->GetBoundingRectangles(&positions.value)) || !positions.value ||
            SafeArrayGetDim(positions.value) != 1 || FAILED(SafeArrayGetLBound(positions.value, 1, &first)) ||
            FAILED(SafeArrayGetUBound(positions.value, 1, &last))) continue;
        for (LONG pos = first; pos <= last - 3 && pieces < 64; pos += 4) {
            double v[4]{};
            bool valid = true;
            for (LONG offset = 0; offset < 4; ++offset) {
                auto index = pos + offset;
                if (FAILED(SafeArrayGetElement(positions.value, &index, v + offset)) ||
                    !std::isfinite(v[offset]) || std::abs(v[offset]) > 1e6) valid = false;
            }
            if (!valid || v[2] <= 0 || v[3] <= 0) continue;
            const auto left = std::max(bounds.left, static_cast<LONG>(std::floor(v[0])));
            const auto top = std::max(bounds.top, static_cast<LONG>(std::floor(v[1])));
            const auto right = std::min(bounds.right, static_cast<LONG>(std::ceil(v[0] + v[2])));
            const auto bottom = std::min(bounds.bottom, static_cast<LONG>(std::ceil(v[1] + v[3])));
            if (right <= left || bottom <= top) continue;
            if (pieces++) rectangles << L',';
            rectangles << L"{\"x\":" << left << L",\"y\":" << top << L",\"width\":" << right-left << L",\"height\":" << bottom-top << L"}";
        }
    }
    com_ptr<IUIAutomationElement> currentFocus;
    BOOL same = FALSE;
    if (foreground() != window || FAILED(client->GetFocusedElement(currentFocus.put())) || !currentFocus ||
        FAILED(client->CompareElements(focus.get(), currentFocus.get(), &same)) || !same || !mayRead(currentFocus.get()))
        return L"{\"status\":\"changed\"}";
    if (std::all_of(text.begin(), text.end(), [](wchar_t c) { return std::iswspace(c) != 0; })) return L"{\"status\":\"empty\"}";
    return L"{\"status\":\"ok\",\"text\":" + quote(text) + L",\"rectangles\":[" + rectangles.str() + L"]}";
}

void watchSelection(DWORD assistant) {
    parentPid = assistant;
    monitorThread = GetCurrentThreadId();
    MSG message{};
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    auto client = automation();
    auto handler = winrt::make<SelectionEvents>();
    com_ptr<IUIAutomationElement> watched;
    auto refresh = [&] {
        if (!client) return;
        if (watched) client->RemoveAutomationEventHandler(UIA_Text_TextSelectionChangedEventId, watched.get(), handler.get());
        watched = nullptr;
        const HWND window = foreground();
        DWORD pid{};
        if (!window || !GetWindowThreadProcessId(window, &pid) || pid == parentPid ||
            FAILED(client->ElementFromHandle(window, watched.put())) || !watched) return;
        client->AddAutomationEventHandler(UIA_Text_TextSelectionChangedEventId, watched.get(), TreeScope_Subtree, nullptr, handler.get());
    };
    const auto watch = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, foregroundHook, 0, 0, WINEVENT_OUTOFCONTEXT);
    const auto mouse = SetWindowsHookExW(WH_MOUSE_LL, mouseHook, GetModuleHandleW(nullptr), 0);
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (!parent) return;
    const UINT_PTR checkParent = SetTimer(nullptr, 1, 1000, nullptr);
    refresh();
    ULONGLONG last{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == WM_TIMER && message.wParam == checkParent &&
            WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) break;
        if (message.message == focusEvent) {
            refresh();
            std::puts("focus");
        } else if (message.message == selectEvent) {
            const auto now = GetTickCount64();
            if (now - last >= 100) { last = now; std::puts("selection"); }
        } else if (message.message == pointerEvent) std::puts(message.wParam ? "drag" : "click");
        else DispatchMessageW(&message);
        std::fflush(stdout);
    }
    if (checkParent) KillTimer(nullptr, checkParent);
    CloseHandle(parent);
    if (mouse) UnhookWindowsHookEx(mouse);
    if (watch) UnhookWinEvent(watch);
}
