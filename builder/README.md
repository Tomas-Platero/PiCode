# PiCode Builder

The window for building PiCode. C# and WinUI 3, in this folder so the pipeline in `dev/` stays what it
is: the engine, runnable without any of this, from a terminal and from CI.

## 🔨 Building and running it

**Double-click `build.cmd`.** That is the whole thing: it builds this and opens it. If something goes
wrong the window stays open with the message instead of vanishing with it.

Or from a terminal:

```bash
cd builder
build.cmd                       # build in Release and run it
build.cmd debug                 # build in Debug and run it
build.cmd build                 # build only, do not run
build.cmd publish               # publish one self-contained .exe to builder\dist
dotnet build                    # compile only
dotnet run                      # compile and open (Debug)
dotnet run -c Release           # compile and open (Release)
```

The executable, if you want a shortcut to it:

```text
builder\bin\Debug\net10.0-windows10.0.19041.0\win-x64\PiCode.Builder.exe
```

Both are also in the editor's task list: **PiCode: build the builder** and **PiCode: run the builder**.

## 📍 Where it has to live

**Inside the repository, ideally.** It drives the scripts in `dev/`, and by default it finds the tree by
looking upwards from where the executable is: keep it anywhere under the repository and everything it
needs is found from there. `publish.cmd` writes it to `builder/dist`, which is inside, so the published
file works where it lands.

Copied somewhere outside, it opens and says the source was not found — and then offers the way back,
because a window that can only say "no" is a dead end:

- **Download source** clones `Tomas-Platero/PiCode` into a folder you pick, and the same window adopts
  the new tree on the spot. No restart.
- **I already have it** points the window at a copy already on the machine. The folder has to be a real
  source tree (the one with `dev/` and `picode-source/`); anything else is refused with the reason.

## 🎚️ Which channel it builds

The channel is what the product is sealed as: **stable**, **beta** or **experimental**.

- **Auto (from branch)** is the default and the owner's rule: `master` builds stable, `beta` builds
  beta, `experimental` builds experimental, and any other branch builds plain PiCode.
- The picker in the rail overrides it. It is the way back when there is no branch to read — a builder
  carried out of the repository on its own, or a source that arrived as a download. Only stable is left
  without a suffix; beta and experimental carry theirs through the folder, the version and the product.

## 🧰 What it needs on the machine

**Nothing installed.** The .NET SDK is the only requirement, and the Windows App SDK arrives as a NuGet
package the first time you build. No Visual Studio workload, no administrator, no runtime installed
beside the executable (it is self-contained).

That is deliberate, and it is the same promise the PowerShell window made before it.

## 🎛️ What it does, and what it deliberately does not

It is a **front-end**: it starts the same `dev/build.sh` pipeline and reads the same
`dev/build-progress.mjs` and `dev/build-requirements.mjs` that the terminal and the old window read.
Nothing about the build lives here.

- **Windows** is built natively, `win-x64`, packaged as a portable folder. There is no Linux side: the
  product is Windows-only.
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
