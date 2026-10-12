// A realistic Ubuntu login message (MOTD) for highlighting tests and the visual baseline.
// Synthetic: documentation-range addresses (RFC 5737, RFC 3849) and example domains only.

/** Every address on the screen, in order, as it must be highlighted. */
export const MOTD_ADDRESSES = [
  "203.0.113.17",
  "2001:db8:85a3::8a2e:370:7334",
  "2a0c:4ac1:3:7c::2",
  "2001:0db8:0000:0000:0000:ff00:0042:8329",
  "fe80::1ff:fe23:4567:890a",
  "2001:db8::",
  "::1",
  "::ffff:192.0.2.128",
  "2001:db8:aaaa:bbbb:cccc:dddd:eeee:1",
  "2001:db8:1::5",
  "198.51.100.23",
];

export const MOTD_LINES = [
  "Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)",
  "",
  " * Documentation:  https://help.ubuntu.com",
  " * Management:     https://landscape.example.com",
  "",
  "  System load:  0.08               Processes:             132",
  "  Usage of /:   41.3% of 24.05GB   Users logged in:       1",
  "  Memory usage: 23%                IPv4 address for eth0: 203.0.113.17",
  "  Swap usage:   0%",
  "  IPv6 address for eth0: 2001:db8:85a3::8a2e:370:7334",
  "  IPv6 address for eth0: 2a0c:4ac1:3:7c::2",
  "  IPv6 address for eth1: 2001:0db8:0000:0000:0000:ff00:0042:8329",
  "  IPv6 address for eth1: fe80::1ff:fe23:4567:890a",
  "  IPv6 routes: 2001:db8:: via ::1",
  "  IPv4-mapped: ::ffff:192.0.2.128",
  "  Gateway:     2001:db8:aaaa:bbbb:cccc:dddd:eeee:1",
  "",
  "*** System restart required ***",
  "Last login: Mon Oct 12 09:14:03 2026 from 2001:db8:1::5",
  "Last login: Sun Oct 11 22:40:51 2026 from 198.51.100.23",
];
