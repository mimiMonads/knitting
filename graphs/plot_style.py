import matplotlib.pyplot as plt

# Gentle dark palette to avoid bright white backgrounds in saved charts.
DARK_BG_HEX = "#0f1116"
DARK_AXES_HEX = "#111318"
DARK_BG_RGB = (15, 17, 22)

def apply_dark_style():
    try:
        plt.style.use("dark_background")
    except Exception:
        pass
    plt.rcParams.update({
        "figure.facecolor": DARK_BG_HEX,
        "axes.facecolor": DARK_AXES_HEX,
        "axes.edgecolor": "#c7c7c7",
        "axes.labelcolor": "#e6e6e6",
        "axes.titlecolor": "#f0f0f0",
        "xtick.color": "#e6e6e6",
        "ytick.color": "#e6e6e6",
        "text.color": "#e6e6e6",
        "grid.color": "#3a3f4b",
        "legend.facecolor": DARK_AXES_HEX,
        "legend.edgecolor": "#2a2f3a",
        "savefig.facecolor": DARK_BG_HEX,
        "savefig.edgecolor": DARK_BG_HEX,
    })
