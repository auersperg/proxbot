# proxbot iOS provider

The bundled iOS sidecar owns the USB packet/syslog capture runtime and the
optional Frida host runtime. Its production capability contract is available
without hardware:

```sh
proxbot-ios-provider probe
```

`frida-preflight` discovers a directly connected or paired iOS device.
`frida-target-preflight --bundle-id BUNDLE_ID` then enumerates the requested
running application, attempts one Frida attach, and immediately detaches. It
never starts the application and never claims plaintext merely because attach
succeeded.

## Stock iOS boundary

Packaging Frida into the macOS sidecar only supplies the host runtime. On a
jailed device, in-process instrumentation additionally requires Developer Mode,
a mounted Developer Disk Image, a debug-signed target with `get-task-allow`, and
a compatible Frida Gadget. A generic App Store distribution process is not an
injectable target. For those builds, proxbot continues to use the explicit HTTP
proxy for application plaintext and passive USB capture for packet/DNS/TLS
metadata.

There is intentionally no Frida plaintext `start` command until
`frida-target-preflight` reports `start_ready: true`. Even then, a future capture
command must report `application_plaintext: true` only after receiving an
observed in-process hook event.
