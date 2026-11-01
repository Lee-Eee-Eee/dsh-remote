"""Render README diagrams with the ohmyplt Arial/Times visual conventions.

These are conceptual diagrams grounded in the host implementation, so no
benchmark data or simulated UI is involved. Matplotlib is an optional authoring
tool; the plugin itself retains zero runtime dependencies and no build step.
Run from any directory: python docs/figures/render.py
"""

from hashlib import sha256
import json
from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
from matplotlib.font_manager import findfont
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "assets"
INK = "#172b40"
MUTED = "#54677a"
BLUE = "#2463b7"
TEAL = "#14776c"
LINE = "#cdd8e2"


def canvas(title, subtitle, height=7.3):
    """Start a fixed-size diagram with room for a title and a caption."""
    fig, ax = plt.subplots(figsize=(16, height), dpi=120)
    fig.patch.set_facecolor("#ffffff")
    fig.subplots_adjust(left=0, right=1, bottom=0, top=1)
    ax.set(xlim=(0, 16), ylim=(0, height))
    ax.axis("off")
    ax.text(.6, height - .7, title, fontsize=27, fontweight="bold", color=INK)
    ax.text(.6, height - 1.12, subtitle, fontsize=14, color=MUTED)
    return fig, ax


def panel(ax, x, y, width, height, fill="#f6f9fc", edge=LINE):
    """Draw a restrained container whose boundary can serve as an arrow port."""
    box = FancyBboxPatch((x, y), width, height,
                         boxstyle="round,pad=0,rounding_size=0.14",
                         linewidth=1.15, facecolor=fill, edgecolor=edge)
    ax.add_patch(box)
    return box


def arrow(ax, start, end, color=BLUE):
    """Route a straight connection between two explicit boundary ports."""
    ax.add_patch(FancyArrowPatch(start, end, arrowstyle="-|>",
                                mutation_scale=15, linewidth=1.7,
                                color=color, shrinkA=0, shrinkB=0))


def label(ax, x, y, text, size=14, color=INK, weight="normal", **kwargs):
    """Keep text labels in Arial; mathematical symbols use Times New Roman."""
    return ax.text(x, y, text, fontsize=size, color=color, fontweight=weight,
                   va="top", linespacing=1.6, **kwargs)


def save(fig, name):
    """Export editable SVG and a GitHub-friendly PNG, then close the figure."""
    svg = OUT / f"{name}.svg"
    fig.savefig(svg, metadata={"Date": None})
    svg.write_text("\n".join(line.rstrip() for line in svg.read_text(encoding="utf-8").splitlines()) + "\n",
                   encoding="utf-8", newline="\n")
    fig.savefig(OUT / f"{name}.png", dpi=150, facecolor="white")
    plt.close(fig)


def architecture():
    """Explain the SSH request path, including the separate proxy port Q."""
    fig, ax = canvas("Remote compute. Local workspace.",
                     "DSH Remote  /  SSH request path and authentication")
    for x, width, title in [(0.6, 3.05, "LOCAL DSH"),
                             (4.0, 6.5, "LOCAL HOST PROCESS"),
                             (10.85, 4.55, "REMOTE LINUX")]:
        panel(ax, x, 2.1, width, 3.4)
        label(ax, x + .22, 5.22, title, 12, MUTED, "bold")

    boxes = [(0.85, 2.55, "Embedded UI", "Conversations\nRemote files & tools"),
             (4.25, 2.75, "Auth proxy", "Cookie stays in memory\nHTTP + WebSocket"),
             (7.65, 2.6, "SSH tunnel", "Native OpenSSH\nLoopback listener"),
             (11.1, 4.05, "Remote DSH", "Runs in the remote workspace\nNode + dsh under ~/.local")]
    for x, width, title, body in boxes:
        panel(ax, x, 2.75, width, 1.85, "white")
        label(ax, x + .2, 4.32, title, 18, INK, "bold")
        label(ax, x + .2, 3.84, body, 12.5, MUTED)

    for start, end in [(3.4, 4.25), (7.0, 7.65), (10.25, 11.1)]:
        arrow(ax, (start, 3.7), (end, 3.7))
    label(ax, 2.12, 2.53, r"127.0.0.1:$Q$", 12, BLUE, ha="center")
    label(ax, 5.62, 2.53, "Inject auth; rewrite origin", 11.5, BLUE, ha="center")
    label(ax, 8.95, 2.53, r"127.0.0.1:$P$", 12, BLUE, ha="center")
    label(ax, 13.12, 2.53, r"127.0.0.1:$P$", 12, BLUE, ha="center")

    panel(ax, .6, .83, 14.8, .88, "#edf5f3", "#bcd9d1")
    label(ax, .86, 1.44, "Setup & control", 13, TEAL, "bold")
    label(ax, 3.05, 1.44, "Scripts over stdin  /  Review install plan  /  Back up config before writing", 13, TEAL)
    label(ax, .6, .48,
          r"SSH forwards the same port $P$ on both ends. Proxy port $Q$ is separate. WSL uses Windows–Linux loopback instead of SSH forwarding.",
          11.3, MUTED)
    save(fig, "architecture")


def workflow():
    """Show the user-visible setup sequence and remote process lifecycle."""
    fig, ax = canvas("From target to workspace.",
                     "DSH Remote  /  Review each setup step, then connect", height=6.8)
    stages = [
        ("01", "Choose a target", "SSH config aliases\nWSL distributions\nOr add a host manually"),
        ("02", "Check the environment", "Probe Node + dsh\nReview missing components\nInstall without sudo"),
        ("03", "Port model config", "Select providers & key refs\nPreview names and counts\nBack up remote files"),
        ("04", "Connect & work", "Full remote DSH interface\nHTTP + WebSocket UI\nReload, restart or stop"),
    ]
    for i, (number, title, body) in enumerate(stages):
        x = .6 + i * 3.78
        panel(ax, x, 2.4, 3.46, 2.7, "#f6f9fc")
        label(ax, x + .23, 4.85, number, 21, BLUE, "bold", fontfamily="Times New Roman")
        label(ax, x + .23, 4.27, title, 15.8, INK, "bold")
        label(ax, x + .23, 3.78, body, 12.6, MUTED)
        if i < 3:
            arrow(ax, (x + 3.46, 3.72), (x + 3.78, 3.72))
    label(ax, .6, 2.1, "Already installed or configured? Continue with the steps you need.", 12.5, MUTED)
    panel(ax, .6, .68, 7.18, .96, "#edf5f3", "#bcd9d1")
    label(ax, .86, 1.39, "Close the panel → reconnect later", 14, TEAL, "bold")
    label(ax, .86, 1.02, "The remote process keeps running when the local connection closes.", 11.7, TEAL)
    panel(ax, 8.02, .68, 7.38, .96, "#f6f9fc")
    label(ax, 8.28, 1.39, "Stop remote → end the remote process", 14, INK, "bold")
    label(ax, 8.28, 1.02, "Use the toolbar when you want to shut the workspace down.", 11.7, MUTED)
    save(fig, "workflow")


def main():
    """Verify fonts, generate both diagrams, and record portable provenance."""
    for font in ("Arial", "Times New Roman"):
        findfont(font, fallback_to_default=False)
    plt.rcParams.update({
        "font.family": "Arial", "svg.fonttype": "none", "svg.hashsalt": "dsh-remote-docs", "pdf.fonttype": 42,
        "mathtext.fontset": "custom", "mathtext.rm": "Times New Roman",
        "mathtext.it": "Times New Roman:italic", "mathtext.bf": "Times New Roman:bold",
    })
    OUT.mkdir(parents=True, exist_ok=True)
    architecture()
    workflow()
    paths = [Path(__file__), ROOT / "lib/manager.js", ROOT / "lib/frame-proxy.js",
             ROOT / "lib/channel.js", ROOT / "client.js"]
    manifest = {
        "renderer": "Matplotlib", "matplotlib_version": matplotlib.__version__,
        "style": "ohmyplt: Arial labels and Times New Roman math/numerals",
        "kind": "conceptual diagrams derived from implementation; no benchmark data",
        "input_text_normalization": "LF",
        "inputs": {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest() for p in paths},
        "outputs": {p.name: sha256(p.read_bytes()).hexdigest()
                    for p in sorted(OUT.glob("*.svg")) + sorted(OUT.glob("*.png"))},
    }
    (OUT / "diagrams.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("Rendered architecture + workflow (PNG/SVG); Arial and Times New Roman verified.")


if __name__ == "__main__":
    main()
