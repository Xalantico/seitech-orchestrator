import net from "node:net";

/** Scans a buffer through clamd's INSTREAM protocol. Returns the signature name when infected. */
export function scanWithClamav(host: string, port: number, data: Buffer, timeoutMs = 20_000): Promise<{ infected: boolean; signature?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = "";
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error("clamd timeout")); });
    socket.on("error", reject);
    socket.on("data", (d) => (response += d.toString()));
    socket.on("close", () => {
      const m = /stream: (.+) FOUND/.exec(response);
      if (m) return resolve({ infected: true, signature: m[1] });
      if (response.includes("OK")) return resolve({ infected: false });
      reject(new Error(`unexpected clamd reply: ${response.trim()}`));
    });
    socket.write("zINSTREAM\0");
    const CHUNK = 64 * 1024;
    for (let off = 0; off < data.length; off += CHUNK) {
      const part = data.subarray(off, off + CHUNK);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(part.length);
      socket.write(len);
      socket.write(part);
    }
    socket.write(Buffer.alloc(4));
  });
}
