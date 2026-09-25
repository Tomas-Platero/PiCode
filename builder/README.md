# PiCode Builder

The window for building PiCode. C# and WinUI 3, in this folder so the pipeline in `dev/` stays what it
is: the engine, runnable without any of this, from a terminal and from CI.

## Building and running it

```bash
cd builder
dotnet build                     # compile
dotnet run                       # compile and open it
dotnet run -c Release            # the smaller, faster one
```

The executable, if you want a shortcut to it:

```text
builder\bin\Debug\net10.0-windows10.0.19041.0\win-x64\PiCode.Builder.exe
```

Both are also in the editor's task list: **PiCode: build the builder** and **PiCode: run the builder**.

## What it needs on the machine

**Nothing installed.** The .NET SDK is the only requirement, and the Windows App SDK arrives as a NuGet
package the first time you build. No Visual Studio workload, no administrator, no runtime installed
beside the executable (it is self-contained).

That is deliberate, and it is the same promise the PowerShell window made before it.

## What it does, and what it deliberately does not

It is a **front-end**: it starts the same `dev/build.sh` pipeline and reads the same
`dev/build-progress.mjs` and `dev/build-requirements.mjs` that the terminal and the old window read.
Nothing about the build lives here.

- **Windows** is built natively, and **Linux through WSL** — the pipeline is the same either way, so
  only the door differs. The Linux side needs WSL with a distribution installed.
- **No timings per step.** The progress module does not measure them. A number invented on a screen
  that exists to tell the truth is a lie; the total elapsed is real and is shown.
- **No architecture dropdown.** The pipeline builds `win-x64` and nothing else, so it is a fact on the
  page, not a control with one option.
- **No colours of its own.** WinUI follows Windows, including the accent colour, which is what makes it
  look native instead of looking like one machine.

## Why it is here and not in `dev/`

`dev/` is the pipeline: shell scripts anyone can run, and the thing CI would run. This is a way of
pressing a button, and it belongs beside the pipeline rather than inside it. The terminal viewer
(`dev/build-live.sh`) and the PowerShell window are still there, and still work.
