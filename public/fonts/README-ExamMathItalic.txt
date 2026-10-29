Exam Math Italic (ExamMathItalic.woff2)

What it is
  A small font used by this program to draw italic variables (x, a, θ, ...) inside
  figure images, so that they look like the letters of the Hangul equation editor.

How it was made
  It is a modified subset of Latin Modern Math, version 1.959
  (latinmodern-math.otf, https://ctan.org/pkg/lm-math).
  Only the math italic letters were kept (A-Z, a-z: U+1D434-U+1D467 and U+210E;
  Greek α-ω: U+1D6FC-U+1D714) and they were mapped to the plain letter code points
  (A-Z, a-z, U+03B1-U+03C9). The MATH table was removed. Digits and symbols are not
  included. Script: scripts/make-math-italic-font.py

Name
  Following the GUST Font License request for derived works, the font was renamed
  from "Latin Modern Math" to "Exam Math Italic".

Copyright and license
  Copyright 2012--2014 for Latin Modern Math OTF by B. Jackowski, P. Strzelczyk and
  P. Pianowski (on behalf of TeX users groups).
  Distributed under the GUST Font License (LaTeX Project Public License 1.3c with an
  additional request); see GUST-FONT-LICENSE.txt in this folder.
  The original, unmodified fonts are available from CTAN: https://ctan.org/pkg/lm-math
