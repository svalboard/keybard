import { vi } from 'vitest';

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom');
}

// Mock WebHID API globally
export const createMockHIDDevice = () => ({
  productId: 0x1234,
  vendorId: 0x5678,
  productName: 'Test Keyboard',
  opened: false,
  collections: [{
    usage: 0x61,
    usagePage: 0xff60,
    inputReports: [],
    outputReports: [],
    featureReports: []
  }],
  open: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  sendReport: vi.fn().mockResolvedValue(undefined),
  sendFeatureReport: vi.fn().mockResolvedValue(undefined),
  receiveFeatureReport: vi.fn().mockResolvedValue(new DataView(new ArrayBuffer(32))),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn().mockReturnValue(true),
  oninputreport: null
});

// Setup global navigator.hid mock
if (!(globalThis as { navigator?: Navigator }).navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    writable: true,
    configurable: true,
  });
}

Object.defineProperty(globalThis.navigator, 'hid', {
  value: {
    requestDevice: vi.fn(),
    getDevices: vi.fn().mockResolvedValue([]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  writable: true,
  configurable: true
});

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
  // Reset the mock implementations to defaults
  const hid = globalThis.navigator.hid as any;
  hid.getDevices.mockResolvedValue([]);
  hid.requestDevice.mockResolvedValue([createMockHIDDevice()]);
});

// Suppress expected console warnings during tests
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeAll(() => {
  console.warn = (...args: any[]) => {
    // Suppress WebHID-related warnings during tests
    if (args[0]?.includes?.('WebHID') || args[0]?.includes?.('USB')) {
      return;
    }
    originalConsoleWarn(...args);
  };

  console.error = (...args: any[]) => {
    // Suppress expected errors during tests
    if (args[0]?.includes?.('Failed to connect') ||
        args[0]?.includes?.('USB device not connected')) {
      return;
    }
    originalConsoleError(...args);
  };
});

afterAll(() => {
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});

// Export types for TypeScript support
declare global {
  interface Navigator {
    hid: {
      requestDevice: ReturnType<typeof vi.fn>;
      getDevices: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };
  }
}

export {};

// The About section and the unstable banner read the public sites'
// version.json (src/utils/site-versions.ts). Tests never reach those sites:
// unless a test stubs fetch itself, the read fails and no version is shown.
{
  const realFetch = globalThis.fetch;
  if (realFetch) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/^https:\/\/(next\.)?keybard\.svalboard\.com\//.test(url)) {
        return Promise.reject(new TypeError('No network in tests'));
      }
      return realFetch(input, init);
    }) as typeof fetch;
  }
}
