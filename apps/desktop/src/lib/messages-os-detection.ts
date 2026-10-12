// User-visible strings for OS auto-detection, kept apart from the other message modules so
// parallel branches never edit the same object.

export const msgOs = {
  setting: "Detect each server's operating system",
  hint: "When a connection opens, Tyrminal reads the server's system name once on a separate channel, never in your shell, to pick the host's icon. Hosts you set an icon for are not read. Turning this off forgets what was detected.",
};
