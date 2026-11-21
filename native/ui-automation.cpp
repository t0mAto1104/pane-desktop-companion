#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "ui-automation.h"
#include <objbase.h>
#include <oleauto.h>
#include <UIAutomation.h>
#include <winrt/base.h>
#include <algorithm>
#include <cwctype>
#include <sstream>
#include <vector>

// The worker is a separate process; a provider that stalls a COM call is terminated by the caller.
namespace {
using winrt::com_ptr;
constexpr size_t NodeLimit = 180;
constexpr int DepthLimit = 10;

std::wstring quote(const std::wstring& text) {
    std::wstringstream result;
    result << L'"';
    for (wchar_t ch : text) {
        if (ch == L'"' || ch == L'\\') result << L'\\' << ch;
        else if (ch < 32) result << L' ';
        else result << ch;
    }
    result << L'"';
    return result.str();
}

struct Text {
    BSTR value{};
    ~Text() { SysFreeString(value); }
    std::wstring bounded() const { return value ? std::wstring(value, std::min(SysStringLen(value), 180u)) : L""; }
};

std::wstring runtimeId(IUIAutomationElement* element) {
    SAFEARRAY* array = nullptr;
    const auto result = element->GetRuntimeId(&array);
    struct Cleanup { SAFEARRAY* array; ~Cleanup() { if (array) SafeArrayDestroy(array); } } cleanup{array};
    if (FAILED(result) || !array || SafeArrayGetDim(array) != 1) return {};
    LONG start{}, end{};
    if (FAILED(SafeArrayGetLBound(array, 1, &start)) || FAILED(SafeArrayGetUBound(array, 1, &end)) ||
        end < start || static_cast<int64_t>(end) - start > 24) return {};
    std::wstring id;
    for (int64_t index = start; index <= end; ++index) {
        LONG position = static_cast<LONG>(index);
        int part{};
        if (FAILED(SafeArrayGetElement(array, &position, &part))) return {};
        id += L":" + std::to_wstring(part);
    }
    return id;
}

bool sensitive(std::wstring label) {
    std::transform(label.begin(), label.end(), label.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
    for (const auto* token : {L"password", L"passcode", L"secret key", L"api key", L"access token",
                              L"credential", L"验证码", L"密钥", L"密码", L"凭据", L"私钥"}) {
        if (label.find(token) != std::wstring::npos) return true;
    }
    return false;
}

struct Node {
    std::wstring id, name, automation, parent;
    std::vector<std::wstring> children;
    CONTROLTYPEID control{};
    RECT bounds{};
    BOOL enabled{}, offscreen{TRUE};
};

struct Scan {
    IUIAutomationTreeWalker* walker;
    DWORD process;
    size_t visited{};
    bool truncated{};
    std::vector<Node> nodes;

    std::wstring visit(IUIAutomationElement* element, const std::wstring& parent, int depth) {
        if (visited >= NodeLimit || depth > DepthLimit) { truncated = true; return {}; }
        ++visited;

        BOOL password = TRUE;
        int pid = 0;
        CONTROLTYPEID control = 0;
        if (FAILED(element->get_CurrentProcessId(&pid)) || static_cast<DWORD>(pid) != process ||
            FAILED(element->get_CurrentIsPassword(&password)) || password ||
            FAILED(element->get_CurrentControlType(&control))) return {};

        // Leave editable fields out altogether. UIA providers may put a value in a control's Name.
        if (control == UIA_EditControlTypeId) return {};
        Text name, automation;
        // A browser Document is structural. Its title/body is unnecessary; walk its controls.
        if (control != UIA_DocumentControlTypeId) element->get_CurrentName(&name.value);
        element->get_CurrentAutomationId(&automation.value);
        auto label = name.bounded();
        auto matcher = automation.bounded();
        if (sensitive(label) || sensitive(matcher)) return {};
        auto id = runtimeId(element);
        if (id.empty() || std::any_of(nodes.begin(), nodes.end(), [&](const Node& node) { return node.id == id; })) return {};

        Node node{id, std::move(label), std::move(matcher), parent, {}, control};
        element->get_CurrentBoundingRectangle(&node.bounds);
        element->get_CurrentIsEnabled(&node.enabled);
        element->get_CurrentIsOffscreen(&node.offscreen);
        const auto position = nodes.size();
        nodes.push_back(std::move(node));

        com_ptr<IUIAutomationElement> child;
        if (SUCCEEDED(walker->GetFirstChildElement(element, child.put()))) {
            while (child) {
                const auto nested = visit(child.get(), id, depth + 1);
                if (!nested.empty()) nodes[position].children.push_back(nested);
                if (visited >= NodeLimit || depth == DepthLimit) { truncated = true; break; }
                com_ptr<IUIAutomationElement> next;
                if (FAILED(walker->GetNextSiblingElement(child.get(), next.put()))) break;
                child = std::move(next);
            }
        }
        return id;
    }
};
}

std::wstring inspectAutomation(HWND window, DWORD process) {
    using namespace winrt;
    com_ptr<IUIAutomation> automation;
    com_ptr<IUIAutomationElement> root;
    com_ptr<IUIAutomationTreeWalker> walker;
    if (FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(automation.put()))) ||
        FAILED(automation->ElementFromHandle(window, root.put())) || !root ||
        FAILED(automation->get_ControlViewWalker(walker.put())) || !walker) return L"{\"elements\":[],\"truncated\":false}";
    Scan scan{walker.get(), process};
    scan.visit(root.get(), {}, 0);

    std::wstringstream out;
    out << L"{\"truncated\":" << (scan.truncated ? L"true" : L"false") << L",\"elements\":[";
    bool first = true;
    for (const auto& node : scan.nodes) {
        if (!first) out << L',';
        first = false;
        out << L"{\"elementId\":" << quote(node.id) << L",\"name\":" << quote(node.name)
            << L",\"automationId\":" << quote(node.automation) << L",\"controlType\":" << node.control
            << L",\"boundingRectangle\":{\"x\":" << node.bounds.left << L",\"y\":" << node.bounds.top
            << L",\"width\":" << static_cast<int64_t>(node.bounds.right) - node.bounds.left
            << L",\"height\":" << static_cast<int64_t>(node.bounds.bottom) - node.bounds.top
            << L"},\"isEnabled\":" << (node.enabled ? L"true" : L"false")
            << L",\"isOffscreen\":" << (node.offscreen ? L"true" : L"false")
            << L",\"processId\":" << process << L",\"parentId\":" << (node.parent.empty() ? L"null" : quote(node.parent))
            << L",\"childrenIds\":[";
        for (size_t i = 0; i < node.children.size(); ++i) {
            if (i) out << L',';
            out << quote(node.children[i]);
        }
        out << L"]}";
    }
    out << L"]}";
    return out.str();
}
