#pragma once
#include <windows.h>
#include <string>

std::wstring selectedText(HWND window, const RECT& bounds);
void watchSelection(DWORD assistant);
