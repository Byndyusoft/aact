# aact — README hero demo
#
# Regenerate from repo root:
#   brew install vhs starship zsh-syntax-highlighting zsh-autosuggestions
#   vhs docs/demo/demo.tape
#
# Output: docs/demo/demo.gif
#
# Flow (visible): init → check (2 violations) → fix (applies the one
#                 deduplicated edit that resolves both) → check (clean)
#                 → analyze. Setup hidden in the Hide block is
#                 environment-only: source the demo zshrc for Starship,
#                 prepare a scratch tmp dir, warm the npx cache so
#                 playback is snappy. The aact flow itself is verbatim
#                 — same output a fresh user sees on their machine.

Output docs/demo/demo.gif

Set FontFamily "Menlo"
Set FontSize 18
Set LetterSpacing 0
Set Width 1400
Set Height 820
Set Padding 28
Set Margin 40
Set MarginFill "#1168bd"
Set BorderRadius 12
Set WindowBar Colorful
Set WindowBarSize 40
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"
Set Shell "zsh"

# Recording-environment setup only — no aact cheating.
Hide
Type "source $(pwd)/docs/demo/.zshrc 2>/dev/null"
Enter
Sleep 1s
Type "rm -rf /tmp/aact-demo && mkdir -p /tmp/aact-demo && cd /tmp/aact-demo && npx -y aact@latest --version > /dev/null 2>&1 && clear"
Enter
Sleep 12s
Show

Type "npx aact init"
Enter
Sleep 2.5s

Type "npx aact check"
Sleep 400ms
Enter
Sleep 3.5s

Type "npx aact check --fix"
Sleep 400ms
Enter
Sleep 3s

Type "npx aact check"
Sleep 400ms
Enter
Sleep 2.5s

Type "npx aact analyze"
Sleep 400ms
Enter
Sleep 4.5s
