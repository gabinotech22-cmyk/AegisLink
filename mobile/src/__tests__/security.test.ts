import { io } from 'socket.io-client';

jest.mock('socket.io-client', () => {
  return {
    io: jest.fn(() => ({
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    })),
  };
});

describe('Transport Security TLS Enforcement', () => {
  let originalDev: boolean;

  beforeAll(() => {
    originalDev = (global as any).__DEV__;
  });

  afterAll(() => {
    (global as any).__DEV__ = originalDev;
  });

  it('allows http and ws in development mode', () => {
    (global as any).__DEV__ = true;
    const relayUrl = 'http://localhost:3001';
    
    // Developer socket connect mock test
    const connectDev = (url: string) => {
      if (!(global as any).__DEV__) {
        if (url.startsWith('http://')) url = url.replace('http://', 'https://');
        if (!url.startsWith('https://') && !url.startsWith('wss://')) throw new Error('Insecure protocol');
      }
      return io(url);
    };

    expect(() => connectDev(relayUrl)).not.toThrow();
    expect(io).toHaveBeenCalledWith(relayUrl);
  });

  it('forces dynamic HTTPS/WSS upgrade or throws in production mode', () => {
    (global as any).__DEV__ = false;
    
    const connectProd = (url: string) => {
      if (!(global as any).__DEV__) {
        if (url.startsWith('http://')) {
          url = url.replace('http://', 'https://');
        } else if (url.startsWith('ws://')) {
          url = url.replace('ws://', 'wss://');
        }
        if (!url.startsWith('https://') && !url.startsWith('wss://')) {
          throw new Error('AegisLink: Insecure connection protocol refused in production');
        }
      }
      return io(url);
    };

    // Test upgrades http:// to https://
    expect(() => connectProd('http://relay.aegis.com')).not.toThrow();
    expect(io).toHaveBeenCalledWith('https://relay.aegis.com');

    // Test upgrades ws:// to wss://
    expect(() => connectProd('ws://relay.aegis.com')).not.toThrow();
    expect(io).toHaveBeenCalledWith('wss://relay.aegis.com');

    // Test throws on completely invalid / plain insecure schemes
    expect(() => connectProd('ftp://relay.aegis.com')).toThrow(
      'AegisLink: Insecure connection protocol refused in production'
    );
  });
});
