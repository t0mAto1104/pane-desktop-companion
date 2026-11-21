#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <winrt/base.h>
#include "voice-audio.h"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <vector>

namespace {
constexpr unsigned inputRate = 16000;
constexpr unsigned outputRate = 22050;
constexpr unsigned limitSeconds = 11;
constexpr size_t outputLimit = outputRate * 2 * 90;
using winrt::com_ptr;
using winrt::check_hresult;

struct DeviceId {
    LPWSTR value{};
    ~DeviceId() { CoTaskMemFree(value); }
};

std::wstring quote(const std::wstring& value) {
    std::wstring out = L"\"";
    for (const auto ch : value) {
        if (ch == L'\\' || ch == L'"') out += L'\\';
        out += ch < 32 ? L' ' : ch;
    }
    return out + L"\"";
}

com_ptr<IMMDeviceEnumerator> enumerator() {
    com_ptr<IMMDeviceEnumerator> result;
    check_hresult(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(result.put())));
    return result;
}

com_ptr<IMMDevice> endpoint(EDataFlow flow, const std::wstring& id) {
    auto devices = enumerator();
    com_ptr<IMMDevice> device;
    if (id.empty()) check_hresult(devices->GetDefaultAudioEndpoint(flow, eConsole, device.put()));
    else check_hresult(devices->GetDevice(id.c_str(), device.put()));
    auto direction = device.as<IMMEndpoint>();
    EDataFlow actual;
    check_hresult(direction->GetDataFlow(&actual));
    DWORD state{};
    check_hresult(device->GetState(&state));
    if (flow != actual || !(state & DEVICE_STATE_ACTIVE)) throw std::runtime_error("audio_device");
    return device;
}

com_ptr<IAudioClient> open(EDataFlow flow, const std::wstring& id, unsigned sampleRate) {
    auto device = endpoint(flow, id);
    com_ptr<IAudioClient> audio;
    check_hresult(device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr, audio.put_void()));
    WAVEFORMATEX format{WAVE_FORMAT_PCM, 1, sampleRate, sampleRate * 2, 2, 16, 0};
    const DWORD flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    check_hresult(audio->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1000000, 0, &format, nullptr));
    return audio;
}

struct Running {
    IAudioClient* client;
    explicit Running(IAudioClient* value) : client(value) { check_hresult(client->Start()); }
    ~Running() { client->Stop(); }
};

bool stopRequested() {
    const auto pipe = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available{};
    return !PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) || available > 0;
}
}

std::wstring audioDevices() {
    auto devices = enumerator();
    std::wstringstream out;
    out << L'[';
    bool comma = false;
    for (const auto flow : {eCapture, eRender}) {
        com_ptr<IMMDeviceCollection> collection;
        check_hresult(devices->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, collection.put()));
        UINT count{};
        check_hresult(collection->GetCount(&count));
        for (UINT index = 0; index < std::min(count, 64u); ++index) {
            com_ptr<IMMDevice> device;
            com_ptr<IPropertyStore> store;
            DeviceId id;
            if (FAILED(collection->Item(index, device.put())) ||
                FAILED(device->GetId(&id.value)) ||
                FAILED(device->OpenPropertyStore(STGM_READ, store.put()))) continue;
            PROPVARIANT label{};
            if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &label)) && label.vt == VT_LPWSTR) {
                if (comma) out << L',';
                comma = true;
                out << L"{\"id\":" << quote(id.value) << L",\"label\":" << quote(label.pwszVal)
                    << L",\"kind\":\"" << (flow == eCapture ? L"input" : L"output") << L"\"}";
            }
            PropVariantClear(&label);
        }
    }
    return out.str() + L"]";
}

void recordAudio(const std::wstring& id) {
    auto audio = open(eCapture, id, inputRate);
    com_ptr<IAudioCaptureClient> capture;
    check_hresult(audio->GetService(IID_PPV_ARGS(capture.put())));
    const size_t limit = inputRate * limitSeconds * 2;
    std::vector<BYTE> result;
    result.reserve(limit);
    {
        Running running(audio.get());
        const auto start = GetTickCount64();
        while (!stopRequested() && result.size() < limit && GetTickCount64() - start < limitSeconds * 1000) {
            UINT32 packet{};
            check_hresult(capture->GetNextPacketSize(&packet));
            if (!packet) { Sleep(12); continue; }
            BYTE* data{};
            UINT32 frames{};
            DWORD flags{};
            check_hresult(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr));
            const auto size = std::min(static_cast<size_t>(frames) * 2, limit - result.size());
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) result.insert(result.end(), size, 0);
            else result.insert(result.end(), data, data + size);
            check_hresult(capture->ReleaseBuffer(frames));
        }
    }
    if (!result.empty() && std::fwrite(result.data(), 1, result.size(), stdout) != result.size())
        throw std::runtime_error("audio_write");
}

void playAudio(const std::wstring& id) {
    std::vector<BYTE> pcm;
    BYTE chunk[8192];
    for (size_t n; (n = std::fread(chunk, 1, sizeof(chunk), stdin)) != 0;) {
        if (pcm.size() + n > outputLimit) throw std::runtime_error("audio_limit");
        pcm.insert(pcm.end(), chunk, chunk + n);
    }
    if (pcm.empty() || pcm.size() % 2 != 0) throw std::runtime_error("audio_format");
    auto audio = open(eRender, id, outputRate);
    com_ptr<IAudioRenderClient> render;
    check_hresult(audio->GetService(IID_PPV_ARGS(render.put())));
    UINT32 capacity{};
    check_hresult(audio->GetBufferSize(&capacity));
    UINT32 padding{};
    size_t sent = 0;
    Running running(audio.get());
    while (sent < pcm.size()) {
        check_hresult(audio->GetCurrentPadding(&padding));
        const UINT32 frames = static_cast<UINT32>(std::min(static_cast<size_t>(capacity - padding), (pcm.size() - sent) / 2));
        if (!frames) { Sleep(12); continue; }
        BYTE* buffer{};
        check_hresult(render->GetBuffer(frames, &buffer));
        std::memcpy(buffer, pcm.data() + sent, static_cast<size_t>(frames) * 2);
        sent += static_cast<size_t>(frames) * 2;
        check_hresult(render->ReleaseBuffer(frames, 0));
    }
    do {
        check_hresult(audio->GetCurrentPadding(&padding));
        if (padding) Sleep(12);
    } while (padding);
}
