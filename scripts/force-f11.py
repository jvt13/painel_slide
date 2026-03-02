import ctypes
import sys
import time

try:
    import pyautogui
except Exception:
    raise SystemExit("pyautogui nao instalado. Rode: pip install pyautogui")


SW_RESTORE = 9
USER32 = ctypes.windll.user32


def enum_windows():
    windows = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def foreach(hwnd, lparam):
        if not USER32.IsWindowVisible(hwnd):
            return True
        length = USER32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        USER32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value.strip()
        if title:
            windows.append((hwnd, title))
        return True

    USER32.EnumWindows(foreach, 0)
    return windows


def focus_window(title_keywords):
    keywords = [k.lower() for k in title_keywords if k]
    if not keywords:
        return False

    windows = enum_windows()
    target_hwnd = None
    for hwnd, title in windows:
        lower = title.lower()
        if any(keyword in lower for keyword in keywords):
            target_hwnd = hwnd
            break

    if not target_hwnd:
        return False

    USER32.ShowWindow(target_hwnd, SW_RESTORE)
    USER32.SetForegroundWindow(target_hwnd)
    return True


def main():
    # Pode receber palavras-chave por argumento: ex "Player" "localhost:3000/player"
    keywords = sys.argv[1:] if len(sys.argv) > 1 else ["Player", "localhost:3000/player"]

    # Tenta foco por alguns ciclos para cobrir o tempo de abertura da janela.
    focused = False
    for _ in range(10):
        if focus_window(keywords):
            focused = True
            break
        time.sleep(0.4)

    if not focused:
        # fallback: ainda tenta o F11 sem foco explícito
        time.sleep(0.5)

    time.sleep(0.2)
    pyautogui.press("f11")


if __name__ == "__main__":
    main()
