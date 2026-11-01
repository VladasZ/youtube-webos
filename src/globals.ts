export type webOSLaunchParams = Record<string, unknown>;

declare global {
  const __YTAF_VERSION__: string;

  interface Window {
    launchParams?: webOSLaunchParams;
    __ytaf_debug__?: boolean;
  }

  interface Document {
    addEventListener(
      eventName: 'webOSRelaunch',
      listener: (evt: CustomEvent<webOSLaunchParams>) => void,
      useCapture?: boolean
    ): void;
  }
}
