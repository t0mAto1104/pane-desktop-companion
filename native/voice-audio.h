#pragma once
#include <string>

std::wstring audioDevices();
void recordAudio(const std::wstring& id);
void playAudio(const std::wstring& id);
