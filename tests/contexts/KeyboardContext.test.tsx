import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { KeyboardProvider, useKeyboard } from '../../src/contexts/KeyboardContext';
import type { KeyboardInfo } from '../../src/types/keyboard.types';

// Mock the services
vi.mock('../../src/services/file.service', () => ({
  fileService: {
    loadFile: vi.fn(),
  },
}));

vi.mock('../../src/services/keyboard.service', () => ({
  keyboardService: {
    init: vi.fn(),
    load: vi.fn(),
    updateKey: vi.fn(),
    getActiveLayerIndex: vi.fn().mockResolvedValue(0),
    getLayerIndexes: vi.fn().mockResolvedValue({ active: 0, defaultLayer: null }),
  },
  KeyboardService: {
    isWebHIDSupported: vi.fn(() => true),
  },
}));

vi.mock('../../src/services/qmk.service', () => ({
  qmkService: {
    get: vi.fn(),
  },
}));

vi.mock('../../src/services/usb.service', () => ({
  usbInstance: {
    openDevice: vi.fn(),
    hasDevice: vi.fn(() => false),
    close: vi.fn().mockResolvedValue(undefined),
    getDeviceName: vi.fn(),
    getAllLayerColors: vi.fn().mockResolvedValue([]),
  },
  SvilUSB: {
    requestDevice: vi.fn(),
    checkFirmware: vi.fn(),
  },
}));

import { fileService } from '../../src/services/file.service';
import { SvilUSB, usbInstance } from '../../src/services/usb.service';
import { LinuxHidAccessError, udevRuleCommand } from '../../src/utils/linux-hid-access';
import { UnsupportedFirmwareError } from '../../src/utils/unsupported-firmware';
import { KeyboardService, keyboardService } from '../../src/services/keyboard.service';

const chosenDevice = { productName: 'Svalboard' } as HIDDevice;

describe('KeyboardContext - File Loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SvilUSB.requestDevice).mockResolvedValue(chosenDevice);
    vi.mocked(SvilUSB.checkFirmware).mockResolvedValue(undefined);
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <KeyboardProvider>{children}</KeyboardProvider>
  );

  it('uses the real USB connection even on a host-served page', async () => {
    document.documentElement.dataset.keybardHost = 'true';
    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    vi.mocked(keyboardService.init).mockResolvedValue(undefined);
    vi.mocked(keyboardService.load).mockResolvedValue({ rows: 10, cols: 6, keymap: [Array(60).fill(4)] });
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    try {
      await act(async () => { await result.current.connect(); });
      expect(usbInstance.openDevice).toHaveBeenCalledTimes(1);
      expect(result.current.isConnected).toBe(true);
      expect(keyboardService.load).toHaveBeenCalled();
    } finally { delete document.documentElement.dataset.keybardHost; }
  });

  it('loadFromFile successfully loads file and updates keyboard state', async () => {
    const mockKeyboardInfo: KeyboardInfo = {
      rows: 6,
      cols: 14,
      kbid: 'test-keyboard',
    };

    vi.mocked(fileService.loadFile).mockResolvedValue(mockKeyboardInfo);

    const { result } = renderHook(() => useKeyboard(), { wrapper });

    const mockFile = new File(['{}'], 'test.kbi', { type: 'application/json' });

    await act(async () => {
      await result.current.loadFromFile(mockFile);
    });

    expect(result.current.keyboard).toEqual(mockKeyboardInfo);
    expect(fileService.loadFile).toHaveBeenCalledWith(mockFile);
  });

  it('loadFromFile sets loadedFrom to file name', async () => {
    const mockKeyboardInfo: KeyboardInfo = {
      rows: 6,
      cols: 14,
    };

    vi.mocked(fileService.loadFile).mockResolvedValue(mockKeyboardInfo);

    const { result } = renderHook(() => useKeyboard(), { wrapper });

    const mockFile = new File(['{}'], 'my-keyboard.kbi', { type: 'application/json' });

    await act(async () => {
      await result.current.loadFromFile(mockFile);
    });

    expect(result.current.loadedFrom).toBe('my-keyboard.kbi');
  });

  it('loadFromFile sets isConnected to false', async () => {
    const mockKeyboardInfo: KeyboardInfo = {
      rows: 6,
      cols: 14,
    };

    vi.mocked(fileService.loadFile).mockResolvedValue(mockKeyboardInfo);

    const { result } = renderHook(() => useKeyboard(), { wrapper });

    const mockFile = new File(['{}'], 'test.kbi', { type: 'application/json' });

    await act(async () => {
      await result.current.loadFromFile(mockFile);
    });

    expect(result.current.isConnected).toBe(false);
  });

  it('loadFromFile throws error for invalid file', async () => {
    vi.mocked(fileService.loadFile).mockRejectedValue(new Error('Invalid file'));

    const { result } = renderHook(() => useKeyboard(), { wrapper });

    const mockFile = new File(['{}'], 'invalid.kbi', { type: 'application/json' });

    await expect(async () => {
      await act(async () => {
        await result.current.loadFromFile(mockFile);
      });
    }).rejects.toThrow('Invalid file');
  });

  it('device connection after file load updates loadedFrom to device name', async () => {
    // First load a file
    const mockFileInfo: KeyboardInfo = {
      rows: 6,
      cols: 14,
    };

    vi.mocked(fileService.loadFile).mockResolvedValue(mockFileInfo);

    const { result } = renderHook(() => useKeyboard(), { wrapper });

    const mockFile = new File(['{}'], 'test.kbi', { type: 'application/json' });

    await act(async () => {
      await result.current.loadFromFile(mockFile);
    });

    expect(result.current.loadedFrom).toBe('test.kbi');

    // Now connect a device
    const mockDeviceInfo: KeyboardInfo = {
      rows: 5,
      cols: 12,
      kbid: 'device-keyboard',
    };

    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    vi.mocked(usbInstance.getDeviceName).mockReturnValue('Svalboard');
    vi.mocked(keyboardService.init).mockResolvedValue(undefined);
    vi.mocked(keyboardService.load).mockResolvedValue(mockDeviceInfo);

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      await result.current.loadKeyboard();
    });

    expect(result.current.loadedFrom).toBe('Svalboard');
  });

  it('file load after device connection updates loadedFrom to file name', async () => {
    // First connect a device
    const mockDeviceInfo: KeyboardInfo = {
      rows: 5,
      cols: 12,
      kbid: 'device-keyboard',
    };

    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    vi.mocked(usbInstance.getDeviceName).mockReturnValue('Svalboard');
    vi.mocked(keyboardService.init).mockResolvedValue(undefined);
    vi.mocked(keyboardService.load).mockResolvedValue(mockDeviceInfo);

    const { result } = renderHook(() => useKeyboard(), { wrapper });

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      await result.current.loadKeyboard();
    });

    expect(result.current.loadedFrom).toBe('Svalboard');

    // Now load a file
    const mockFileInfo: KeyboardInfo = {
      rows: 6,
      cols: 14,
    };

    vi.mocked(fileService.loadFile).mockResolvedValue(mockFileInfo);

    const mockFile = new File(['{}'], 'test.kbi', { type: 'application/json' });

    await act(async () => {
      await result.current.loadFromFile(mockFile);
    });

    expect(result.current.loadedFrom).toBe('test.kbi');
  });

  it('disconnect retains draft source identity', async () => {
    // First connect a device
    const mockDeviceInfo: KeyboardInfo = {
      rows: 5,
      cols: 12,
      kbid: 'device-keyboard',
    };

    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    vi.mocked(usbInstance.getDeviceName).mockReturnValue('Svalboard');
    vi.mocked(keyboardService.init).mockResolvedValue(undefined);
    vi.mocked(keyboardService.load).mockResolvedValue(mockDeviceInfo);

    const { result } = renderHook(() => useKeyboard(), { wrapper });

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      await result.current.loadKeyboard();
    });

    expect(result.current.loadedFrom).toBe('Svalboard');

    // Now disconnect
    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.loadedFrom).toBe('Svalboard');
    expect(result.current.connectionState).toBe('offline');
  });
  it('does not borrow capabilities from a previously loaded target and closes USB', async () => {
    vi.mocked(fileService.loadFile).mockResolvedValueOnce({rows: 1, cols: 1, name: 'old', macros_size: 999})
      .mockResolvedValueOnce({rows: 2, cols: 2});
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.loadFromFile(new File(['{}'], 'old.svil')); });
    const firstSession = result.current.connectionSessionId;
    await act(async () => { await result.current.loadFromFile(new File(['{}'], 'new.svil')); });
    expect(result.current.keyboard?.name).toBeUndefined();
    expect(result.current.keyboard?.macros_size).toBeUndefined();
    expect(usbInstance.close).toHaveBeenCalledTimes(2);
    expect(result.current.connectionSessionId).toBeGreaterThan(firstSession);
  });

  it('preserves a dirty draft when target change is cancelled', async () => {
    vi.mocked(fileService.loadFile).mockResolvedValue({rows: 1, cols: 1});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.loadFromFile(new File(['{}'], 'draft.svil')); });
    act(() => result.current.setKeyboard(kb => ({...kb!, name: 'edited'})));
    await act(async () => { await result.current.connect(); });
    expect(usbInstance.openDevice).not.toHaveBeenCalled();
    expect(result.current.keyboard?.name).toBe('edited');
    confirm.mockRestore();
  });

  it('never asks to discard edits on a firmware update reconnect', async () => {
    vi.mocked(fileService.loadFile).mockResolvedValue({rows: 1, cols: 1});
    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.loadFromFile(new File(['{}'], 'draft.svil')); });
    act(() => result.current.setKeyboard(kb => ({...kb!, name: 'edited'})));
    let connected: boolean | undefined;
    await act(async () => { connected = await result.current.connectDevice(chosenDevice, { discardEdits: true }); });
    expect(confirm).not.toHaveBeenCalled();
    expect(usbInstance.openDevice).toHaveBeenCalledWith(chosenDevice);
    expect(connected).toBe(true);
    confirm.mockRestore();
  });

  it('normalizes string file failures and preserves current target', async () => {
    vi.mocked(fileService.loadFile).mockRejectedValue('Empty file');
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await expect(result.current.loadFromFile(new File([''], 'empty.svil'))).rejects.toThrow('Empty file');
    expect(usbInstance.close).not.toHaveBeenCalled();
    expect(result.current.connectionSessionId).toBe(0);
  });

  it('does not mark unrelated edits saved when acknowledging an earlier snapshot', async () => {
    vi.mocked(fileService.loadFile).mockResolvedValue({rows: 1, cols: 1});
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.loadFromFile(new File(['{}'], 'draft.svil')); });
    const confirmed = result.current.getKeyboardSnapshot()!;
    act(() => result.current.setKeyboard(kb => ({...kb!, name: 'newer edit'})));
    act(() => result.current.markAsSaved(confirmed));
    expect(result.current.hasUnsavedChanges).toBe(true);
  });

  it('loads offline files in browsers without WebHID', async () => {
    vi.mocked(KeyboardService.isWebHIDSupported).mockReturnValue(false);
    vi.mocked(fileService.loadFile).mockResolvedValue({rows: 1, cols: 1});
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.loadFromFile(new File(['{}'], 'offline.svil')); });
    expect(result.current.keyboard).not.toBeNull();
    expect(usbInstance.close).not.toHaveBeenCalled();
    vi.mocked(KeyboardService.isWebHIDSupported).mockReturnValue(true);
  });

  it('offers the udev fix when Linux refuses to open the device, and clears it on retry', async () => {
    vi.mocked(usbInstance.openDevice).mockRejectedValueOnce(new LinuxHidAccessError(0x303a, 0x4044));
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.connect(); });
    expect(result.current.connectionState).toBe('error');
    expect(result.current.connectionError).toMatch(/udev rule/);
    expect(result.current.connectionFix).toBe(udevRuleCommand(0x303a, 0x4044));

    vi.mocked(usbInstance.openDevice).mockRejectedValueOnce(new Error('Device busy'));
    await act(async () => { await result.current.connect(); });
    expect(result.current.connectionError).toBe('Device busy');
    expect(result.current.connectionFix).toBeNull();
  });

  it('loads once automatically and exposes failures without a writable connection', async () => {
    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    vi.mocked(keyboardService.load).mockRejectedValueOnce(new Error('Definition read failed'));
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.connectionState).toBe('error'));
    expect(result.current.connectionError).toBe('Definition read failed');
    expect(result.current.isConnected).toBe(false);
    expect(keyboardService.load).toHaveBeenCalledTimes(1);
    expect(usbInstance.close).toHaveBeenCalled();
  });

  it('exposes old firmware found while loading, and clears it on the next attempt', async () => {
    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    vi.mocked(keyboardService.load).mockRejectedValueOnce(new UnsupportedFirmwareError({ kind: 'svalboard-vial', reportedVersion: 'v2025-11-01' }));
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.connectionState).toBe('error'));
    expect(result.current.connectionFirmware).toEqual({ kind: 'svalboard-vial', reportedVersion: 'v2025-11-01' });
    expect(result.current.connectionError).toContain('old Vial firmware (v2025-11-01)');
    vi.mocked(usbInstance.openDevice).mockRejectedValueOnce(new Error('Device busy'));
    await act(async () => { await result.current.connect(); });
    expect(result.current.connectionFirmware).toBeNull();
  });

  it('waits for the previous write guard before opening another transport', async () => {
    vi.mocked(usbInstance.openDevice).mockResolvedValue(false);
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    let finish!: (release: (discard?: boolean) => void) => void;
    const release = vi.fn();
    result.current.registerTargetChangeGuard(() => new Promise(resolve => { finish = resolve; }));
    let connecting!: Promise<boolean>;
    act(() => { connecting = result.current.connect(); });
    // The guard is reached once the board is chosen and has passed the firmware check.
    await waitFor(() => expect(finish).toBeDefined());
    expect(usbInstance.openDevice).not.toHaveBeenCalled();
    await act(async () => { finish(release); await connecting; });
    expect(usbInstance.openDevice).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(false);
  });

  it('discards old queued callbacks only after successfully switching to an offline file', async () => {
    vi.mocked(fileService.loadFile).mockResolvedValue({rows: 1, cols: 1});
    const release = vi.fn();
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    result.current.registerTargetChangeGuard(async () => release);
    await act(async () => { await result.current.loadFromFile(new File(['{}'], 'offline.svil')); });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('serializes maintenance with queued writes and preserves pending callbacks', async () => {
    vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
    vi.mocked(keyboardService.load).mockResolvedValue({rows: 1, cols: 1});
    const { result } = renderHook(() => useKeyboard(), { wrapper });
    await act(async () => { await result.current.connect(); });
    const release = vi.fn();
    let finish!: (release: (discard?: boolean) => void) => void;
    result.current.registerTargetChangeGuard(() => new Promise(resolve => { finish = resolve; }));
    const operation = vi.fn().mockResolvedValue('saved');
    let maintenance!: Promise<unknown>;
    act(() => { maintenance = result.current.runDeviceMaintenance(operation); });
    expect(operation).not.toHaveBeenCalled();
    await act(async () => { finish(release); expect(await maintenance).toBe('saved'); });
    expect(release).toHaveBeenCalledWith(false);
  });

  describe('checks the firmware before changing the editing target', () => {
    const vial = new UnsupportedFirmwareError({ kind: 'svalboard-vial', reportedVersion: 'v2025-11-01' });

    it('keeps an offline draft, and never asks to discard it, when the board runs old firmware', async () => {
      vi.mocked(fileService.loadFile).mockResolvedValue({ rows: 1, cols: 1 });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { result } = renderHook(() => useKeyboard(), { wrapper });
      await act(async () => { await result.current.loadFromFile(new File(['{}'], 'draft.svil')); });
      act(() => result.current.setKeyboard(kb => ({ ...kb!, name: 'edited' })));
      const session = result.current.connectionSessionId;

      vi.mocked(SvilUSB.checkFirmware).mockRejectedValueOnce(vial);
      let connected: boolean | undefined;
      await act(async () => { connected = await result.current.connect(); });

      expect(connected).toBe(false);
      expect(SvilUSB.checkFirmware).toHaveBeenCalledWith(chosenDevice);
      expect(confirm).not.toHaveBeenCalled();
      expect(usbInstance.openDevice).not.toHaveBeenCalled();
      expect(result.current.keyboard?.name).toBe('edited');
      expect(result.current.loadedFrom).toBe('draft.svil');
      expect(result.current.connectionState).toBe('offline');
      expect(result.current.connectionSessionId).toBe(session);
      expect(result.current.connectionFirmware).toEqual({ kind: 'svalboard-vial', reportedVersion: 'v2025-11-01' });
      confirm.mockRestore();
    });

    it('stays connected to the current board when another board runs old firmware', async () => {
      vi.mocked(usbInstance.openDevice).mockResolvedValue(true);
      vi.mocked(usbInstance.getDeviceName).mockReturnValue('Svalboard');
      vi.mocked(keyboardService.load).mockResolvedValue({ rows: 5, cols: 12, kbid: 'first' });
      const { result } = renderHook(() => useKeyboard(), { wrapper });
      await act(async () => { await result.current.connect(); });
      await waitFor(() => expect(result.current.isConnected).toBe(true));

      const other = { productName: 'Other' } as HIDDevice;
      vi.mocked(SvilUSB.checkFirmware).mockRejectedValueOnce(vial);
      await act(async () => { await result.current.connectDevice(other); });

      expect(usbInstance.openDevice).toHaveBeenCalledTimes(1);
      expect(result.current.isConnected).toBe(true);
      expect(result.current.keyboard?.kbid).toBe('first');
      expect(result.current.connectionFirmware?.kind).toBe('svalboard-vial');
    });

    it('changes nothing when the chooser is closed without picking a board', async () => {
      vi.mocked(fileService.loadFile).mockResolvedValue({ rows: 1, cols: 1 });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { result } = renderHook(() => useKeyboard(), { wrapper });
      await act(async () => { await result.current.loadFromFile(new File(['{}'], 'draft.svil')); });
      act(() => result.current.setKeyboard(kb => ({ ...kb!, name: 'edited' })));

      vi.mocked(SvilUSB.requestDevice).mockResolvedValueOnce(null);
      await act(async () => { await result.current.connect(); });

      expect(SvilUSB.checkFirmware).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(result.current.keyboard?.name).toBe('edited');
      expect(result.current.connectionState).toBe('offline');
      confirm.mockRestore();
    });

    it('asks to discard edits only after the board passes the check', async () => {
      vi.mocked(fileService.loadFile).mockResolvedValue({ rows: 1, cols: 1 });
      const order: string[] = [];
      vi.mocked(SvilUSB.checkFirmware).mockImplementationOnce(async () => { order.push('check'); });
      const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => { order.push('confirm'); return false; });
      const { result } = renderHook(() => useKeyboard(), { wrapper });
      await act(async () => { await result.current.loadFromFile(new File(['{}'], 'draft.svil')); });
      act(() => result.current.setKeyboard(kb => ({ ...kb!, name: 'edited' })));

      await act(async () => { await result.current.connect(); });

      expect(order).toEqual(['check', 'confirm']);
      expect(usbInstance.openDevice).not.toHaveBeenCalled();
      expect(result.current.keyboard?.name).toBe('edited');
      confirm.mockRestore();
    });

    it('skips the separate check when reopening the board already connected', async () => {
      vi.mocked(usbInstance.hasDevice).mockReturnValueOnce(true);
      vi.mocked(usbInstance.openDevice).mockResolvedValue(false);
      const { result } = renderHook(() => useKeyboard(), { wrapper });
      await act(async () => { await result.current.connectDevice(chosenDevice); });
      expect(SvilUSB.checkFirmware).not.toHaveBeenCalled();
      expect(usbInstance.openDevice).toHaveBeenCalledWith(chosenDevice);
    });
  });

});
