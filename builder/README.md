# PiCode Builder

The window for building PiCode. C# and WinUI 3, in this folder so the pipeline in `dev/` stays what it
is: the engine, runnable without any of this, from a terminal and from CI.

## 🔨 Building and running it

**Double-click `build.cmd`.** That is the whole thing: it builds this and opens it. If something goes
wrong the window stays open with the message instead of vanishing with it.

Or from a terminal:

```bash
cd builder
build.cmd                       # same thing
dotnet build                     # compile only
dotnet run                       # compile and open
dotnet run -c Release            # the smaller, faster one
```

The executable, if you want a shortcut to it:

```text
builder\bin\Debug\net10.0-windows10.0.19041.0\win-x64\PiCode.Builder.exe
```

Both are also in the editor's task list: **PiCode: build the builder** and **PiCode: run the builder**.

## 📍 Where it has to live

**Inside the repository.** It drives the scripts in `dev/`, so it finds the tree by looking upwards from
where the executable is: keep it anywhere under the repository and everything it needs is found from
there. `publish.cmd` writes it to `builder/dist`, which is inside, so the published file works where it
lands.

Copied somewhere outside, it opens window and says the repository was not found. It does not guess, and
it does not build the wrong thing.

Being able to point it at a repository from outside was tried and abandoned: with a repository
remembered, the window opened and then died while drawing, before a single line of its own refresh code
ran. It is not offered, because a door that crashes is worse than no door. The state that works is the
one that is shipped.

## 🧰 What it needs on the machine

**Nothing installed.** The .NET SDK is the only requirement, and the Windows App SDK arrives as a NuGet
package the first time you build. No Visual Studio workload, no administrator, no runtime installed
beside the executable (it is self-contained).

That is deliberate, and it is the same promise the PowerShell window made before it.

## 🎛️ What it does, and what it deliberately does not

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

## 🧭 Why it is here and not in `dev/`

`dev/` is the pipeline: shell scripts anyone can run, and the thing CI would run. This is a way of
pressing a button, and it belongs beside the pipeline rather than inside it. The terminal viewer
(`dev/build-live.sh`) and the PowerShell window are still there, and still work.
