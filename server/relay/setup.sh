#!/bin/bash
# Sets up PartyLink's own RetroArch relay server on a fresh Ubuntu machine
# (for example an AWS EC2 server in Sydney). Paste it into "User data" when
# launching the server, or run it once with sudo. It runs libretro's
# netplay-tunnel-server on TCP port 55435 and starts it again after reboots.
set -euo pipefail

COMMIT=23ddababf1ce1c600b7ac108ec7fb683e564d0ba
SHA256=dfc0563bf5dada29f2336e203f045eae3b29badb3d89ee0b3ac2cb6a56599eea
DIR=/opt/partylink-relay

apt-get update -q
apt-get install -y -q python3 curl

id relay >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin relay
mkdir -p "$DIR"
curl -fsSL -o "$DIR/retroarch_tunnel_server.py" \
  "https://raw.githubusercontent.com/libretro/netplay-tunnel-server/$COMMIT/retroarch_tunnel_server.py"
echo "$SHA256  $DIR/retroarch_tunnel_server.py" | sha256sum -c -

cat > "$DIR/retroarch_tunnel_server.ini" <<'INI'
[Server]
Port = 55435
Timeout = 120

[Session]
Max = 32
Clients = 8

[Log]
Path = tunnel.log
Level = info
INI
chown -R relay:relay "$DIR"

cat > /etc/systemd/system/partylink-relay.service <<UNIT
[Unit]
Description=PartyLink RetroArch relay server
After=network.target

[Service]
WorkingDirectory=$DIR
ExecStart=/usr/bin/python3 -SOO $DIR/retroarch_tunnel_server.py $DIR/retroarch_tunnel_server.ini
Restart=always
RestartSec=5
User=relay
Group=relay

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now partylink-relay.service
