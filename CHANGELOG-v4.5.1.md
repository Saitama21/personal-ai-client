# v4.5.1 — DPK Roller PDF test

- Added deterministic PDF text extraction in local MOCK_MODE via `pypdf`.
- Added recognition profile for ROZFOOD drawing `ДПК-5.02.103` (Ролик, PE 500).
- Extracts Ø60, Ø50, Ø30×8, Ø12.2, L30, L25, L22, L8, R3.5, 1×45°, quantity 28 and general tolerances.
- Generates outer X/Z contour with the R3.5 tangent points and a separate inner contour.
- Produces a two-setup ShopTurn / Stock Removal route.
- Added three endpoint regression tests using the uploaded control PDF.
