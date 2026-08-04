# Build report — v5.0.0 Professional Digital Twin

Target machine: Zhongshan Tengyue CK52PT-Y with SINUMERIK 828D PPU271.4.

## Implemented

- SINUMERIK-style operator interface and softkeys.
- Three-jaw chuck left; Ø60 clamp setup; protected clamp envelope.
- Fifteen-position turret right with animated T1–T15 indexing.
- Progressive stock removal and target surface.
- Realistic tool classes for turning, drilling, live radial drilling, milling, and cutoff.
- Camera presets: machine view, front, top, isometric, tool view, follow tool.
- Collision engine visualization, red collision indication, and feed stop.
- Live machine telemetry X/Y/Z/C/T/F/S.

## Safety boundary

This is a planning and visualization digital twin. Production collision certification and automatic production MPF remain dependent on confirmed machine envelopes, tool-holder dimensions, OEM M codes, soft limits, PLC interlocks, and actual jaw geometry.
