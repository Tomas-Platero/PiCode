/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { join } from 'path';
import { createInterface } from 'readline';
import { MAX_LINE_BYTES } from './picodeAgentBridgeProtocol.js';

/**
 * A Windows named pipe that only this Windows account, on this computer, can open.
 *
 * Node's own pipes cannot do that: libuv creates them with the default security descriptor and
 * without `PIPE_REJECT_REMOTE_CLIENTS`, and measured on 2026-11-26 such a pipe answered through
 * `\\localhost\pipe\…` and `\\<computer>\pipe\…`, the paths a client on another computer uses.
 * So the pipe is created by a small helper in Windows PowerShell (present on every Windows), with:
 * - `PIPE_REJECT_REMOTE_CLIENTS`: Windows refuses every client that arrives over the network;
 * - a protected DACL that allows only the current user and denies NETWORK;
 * - `FILE_FLAG_FIRST_PIPE_INSTANCE` on a name with a random part, so no other process can have
 *   created the name first and be listening in its place.
 *
 * The helper only moves bytes. Each line a client writes comes out on its stdout as
 * `<connection>\t<base64>`; each `<connection>\t<base64>` written to its stdin goes back to that
 * client as one line, `<connection>\tclose` hangs up, and a client that leaves is reported as
 * `<connection>\tEOF`. It exits as soon as its stdin closes, so it never outlives PiCode.
 */

const HELPER_SOURCE = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PicodeAgentPipe {
	[StructLayout(LayoutKind.Sequential)]
	struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES sa);

	const uint PIPE_ACCESS_DUPLEX = 0x3;
	const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
	// Overlapped, so one thread can write a reply while another is blocked reading: on a
	// synchronous handle Windows serialises the two and the reply waits for the next read.
	const uint FILE_FLAG_OVERLAPPED = 0x40000000;
	const uint PIPE_REJECT_REMOTE_CLIENTS = 0x8;

	static readonly object outLock = new object();
	static StreamWriter stdout;
	static readonly Dictionary<int, Stream> clients = new Dictionary<int, Stream>();
	static int nextId = 0;

	static void Emit(string line) {
		lock (outLock) { stdout.Write(line); stdout.Write("\n"); stdout.Flush(); }
	}

	static SafePipeHandle Create(string name, byte[] sd, bool first) {
		IntPtr p = Marshal.AllocHGlobal(sd.Length);
		try {
			Marshal.Copy(sd, 0, p, sd.Length);
			SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
			sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
			sa.lpSecurityDescriptor = p;
			sa.bInheritHandle = 0;
			SafePipeHandle h = CreateNamedPipeW("\\\\.\\pipe\\" + name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_REJECT_REMOTE_CLIENTS, 255, 65536, 65536, 0, ref sa);
			if (h.IsInvalid) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
			return h;
		} finally { Marshal.FreeHGlobal(p); }
	}

	static void Serve(int id, NamedPipeServerStream pipe, int maxLine) {
		try {
			MemoryStream line = new MemoryStream();
			byte[] buffer = new byte[8192];
			// A line over the limit is reported once and the rest of it, up to its newline, is
			// thrown away: its tail must not be read as a request of its own.
			bool discarding = false;
			while (true) {
				int n = pipe.Read(buffer, 0, buffer.Length);
				if (n <= 0) { break; }
				for (int i = 0; i < n; i++) {
					byte b = buffer[i];
					if (b == 10) {
						if (!discarding) { Emit(id + "\t" + Convert.ToBase64String(line.ToArray())); }
						discarding = false;
						line.SetLength(0);
					} else if (b != 13 && !discarding) {
						if (line.Length >= maxLine) { Emit(id + "\tTOOLONG"); line.SetLength(0); discarding = true; continue; }
						line.WriteByte(b);
					}
				}
			}
		} catch (Exception) {
		} finally {
			lock (clients) { clients.Remove(id); }
			try { pipe.Dispose(); } catch (Exception) { }
			Emit(id + "\tEOF");
		}
	}

	static void Commands() {
		StreamReader stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
		while (true) {
			string command = stdin.ReadLine();
			if (command == null) { Environment.Exit(0); }
			int tab = command.IndexOf('\t');
			if (tab <= 0) { continue; }
			int id;
			if (!int.TryParse(command.Substring(0, tab), out id)) { continue; }
			string body = command.Substring(tab + 1);
			Stream client;
			lock (clients) { if (!clients.TryGetValue(id, out client)) { continue; } }
			try {
				if (body == "close") { client.Dispose(); continue; }
				byte[] bytes = Convert.FromBase64String(body);
				lock (client) { client.Write(bytes, 0, bytes.Length); client.WriteByte(10); client.Flush(); }
			} catch (Exception) { }
		}
	}

	public static void Run(string name, byte[] sd, int maxLine) {
		stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
		SafePipeHandle handle;
		try { handle = Create(name, sd, true); }
		catch (Exception e) { Emit("0\tERROR\t" + e.Message.Replace("\t", " ").Replace("\n", " ")); return; }
		Thread commands = new Thread(Commands);
		commands.IsBackground = true;
		commands.Start();
		Emit("0\tREADY");
		while (true) {
			NamedPipeServerStream pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
			pipe.WaitForConnection();
			// The next instance exists before this one is handed over, so the name never has zero
			// instances: otherwise another account could create it in between, with its own rules.
			// Not being able to create it ends the helper, and the bridge reports that it stopped.
			try { handle = Create(name, sd, false); }
			catch (Exception e) { Emit("0\tSTOPPED\t" + e.Message.Replace("\t", " ").Replace("\n", " ")); Environment.Exit(1); }
			int id = Interlocked.Increment(ref nextId);
			lock (clients) { clients[id] = pipe; }
			NamedPipeServerStream current = pipe;
			Thread t = new Thread(delegate () { Serve(id, current, maxLine); });
			t.IsBackground = true;
			t.Start();
		}
	}
}
`;

function helperScript(pipeName: string): string {
	return [
		'$ErrorActionPreference = "Stop"',
		`Add-Type -TypeDefinition @'\n${HELPER_SOURCE}\n'@`,
		'$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
		// Protected DACL (P): deny NETWORK (NU), allow only this user. Nobody else is listed.
		'$raw = New-Object System.Security.AccessControl.RawSecurityDescriptor("D:P(D;;GA;;;NU)(A;;GA;;;$me)")',
		'$sd = New-Object byte[] $raw.BinaryLength',
		'$raw.GetBinaryForm($sd, 0)',
		`[PicodeAgentPipe]::Run('${pipeName.replace(/'/g, '')}', $sd, ${MAX_LINE_BYTES})`,
	].join('\n');
}

export interface LocalPipeListener {
	/** A full line arrived from a client. */
	onLine(connection: number, line: string): void;
	/** A client sent a line longer than the bridge reads. */
	onTooLong(connection: number): void;
	/** A client left. */
	onClose(connection: number): void;
	/** The helper stopped on its own; the bridge is no longer listening. */
	onExit(reason: string): void;
}

export class LocalPipeServer {

	private constructor(private readonly child: ChildProcessWithoutNullStreams) { }

	/** Starts the helper and resolves once the pipe exists, or rejects with the reason it does not. */
	static start(pipeName: string, listener: LocalPipeListener, timeoutMs = 20_000): Promise<LocalPipeServer> {
		const encoded = Buffer.from(helperScript(pipeName), 'utf16le').toString('base64');
		// By full path: never whatever `powershell.exe` the search path finds first.
		const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const server = new LocalPipeServer(child);
		return new Promise((resolvePromise, rejectPromise) => {
			let ready = false;
			let stderr = '';
			const timer = setTimeout(() => {
				if (!ready) {
					child.kill();
					rejectPromise(new Error('the local pipe helper did not start in time'));
				}
			}, timeoutMs);
			child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
			child.on('error', error => {
				clearTimeout(timer);
				if (!ready) {
					rejectPromise(error);
				} else {
					listener.onExit(error.message);
				}
			});
			child.on('exit', code => {
				clearTimeout(timer);
				const reason = `the local pipe helper exited (${code ?? 'signal'})${stderr ? `: ${stderr.trim()}` : ''}`;
				if (!ready) {
					rejectPromise(new Error(reason));
				} else {
					listener.onExit(reason);
				}
			});
			createInterface({ input: child.stdout }).on('line', raw => {
				const tab = raw.indexOf('\t');
				if (tab <= 0) {
					return;
				}
				const connection = Number(raw.slice(0, tab));
				const body = raw.slice(tab + 1);
				if (connection === 0) {
					if (body === 'READY') {
						ready = true;
						clearTimeout(timer);
						resolvePromise(server);
					} else if (body.startsWith('ERROR')) {
						clearTimeout(timer);
						child.kill();
						rejectPromise(new Error(`the local pipe could not be created: ${body.slice(6)}`));
					}
					return;
				}
				if (!Number.isInteger(connection)) {
					return;
				}
				if (body === 'EOF') {
					listener.onClose(connection);
				} else if (body === 'TOOLONG') {
					listener.onTooLong(connection);
				} else {
					listener.onLine(connection, Buffer.from(body, 'base64').toString('utf8'));
				}
			});
		});
	}

	send(connection: number, line: string): void {
		if (!this.child.stdin.destroyed) {
			this.child.stdin.write(`${connection}\t${Buffer.from(line, 'utf8').toString('base64')}\n`);
		}
	}

	close(connection: number): void {
		if (!this.child.stdin.destroyed) {
			this.child.stdin.write(`${connection}\tclose\n`);
		}
	}

	dispose(): void {
		this.child.stdin.end();
		this.child.kill();
	}
}
