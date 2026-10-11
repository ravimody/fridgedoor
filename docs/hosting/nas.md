# Run Fridgedoor on a NAS

A NAS is already always on, which makes it a good free home for Fridgedoor. This page covers Synology, Unraid and TrueNAS SCALE.

On a NAS, Fridgedoor's data lives in an ordinary folder you can see and back up. The examples use a folder called `fridgedoor`.

NAS software changes between versions, and we haven't tested every step below on every model. If a menu name differs on your NAS, look for the closest match. Please tell us so we can fix this page.

## A compose file for NAS apps

NAS app managers may bundle an older version of Docker Compose, and they don't always support the "profiles" that the main `compose.yaml` uses. Use this simpler file instead. It runs Fridgedoor plus Tailscale for HTTPS (see [HTTPS explained](https.md)):

```yaml
services:
  fridgedoor:
    image: ghcr.io/ravimody/fridgedoor:latest
    restart: unless-stopped
    ports:
      - "8080:8080"           # change the left number if 8080 is taken on your NAS
    volumes:
      - ./data:/data          # Fridgedoor's database and secret.key

  tailscale:
    image: tailscale/tailscale:stable
    hostname: fridgedoor
    restart: unless-stopped
    environment:
      TS_AUTHKEY: tskey-auth-PASTE-YOUR-KEY
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
      TS_USERSPACE: "true"
    volumes:
      - ./tailscale:/var/lib/tailscale
      - ./tailscale-serve.json:/config/serve.json:ro
    depends_on: [fridgedoor]
```

Before you use it:

1. Get a Tailscale auth key and turn on HTTPS. If you want phones without the Tailscale app to connect, also turn on Funnel. Steps 1-4 of the [Tailscale instructions](home-server.md#option-a-tailscale) cover all of this.
2. Download [`tailscale-serve.json`](https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/tailscale-serve.json) into the `fridgedoor` folder, next to the compose file.

To use a Cloudflare Tunnel instead, replace the `tailscale` service with this one. Set up the tunnel as described in the [Cloudflare instructions](home-server.md#option-b-cloudflare-tunnel), with the service URL `http://fridgedoor:8080`:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: PASTE-YOUR-TUNNEL-TOKEN
    depends_on: [fridgedoor]
```

To try Fridgedoor on your home network first, delete the `tailscale` service. Then open `http://<NAS IP address>:8080`.

## Synology

Container Manager runs on Synology "+" models with Intel or AMD processors. It also runs on several recent ARM models, such as the DS124, DS223, DS223j and DS423. Older ARMv7 models can't run it. It needs DSM 7.2 or later.

1. Open **Package Center** and install **Container Manager**.
2. In **File Station**, create a folder `docker/fridgedoor`. Inside it, create empty folders named `data` and `tailscale`. Upload `tailscale-serve.json` into `docker/fridgedoor`.
3. Open **Container Manager > Project** and click **Create**.
   - Project name: `fridgedoor`
   - Path: the `docker/fridgedoor` folder
   - Source: **Create docker-compose.yml**. Paste the compose file above, with your auth key filled in.
4. Click **Next** until the project builds and starts.
5. Find the setup link. Open **Container Manager > Container**, select the `fridgedoor` container and look at its **Log** tab. Near the top you'll see "Open this link to create your household". If the link starts with `http://localhost:8080`, replace that part with your address, `https://fridgedoor.<your-tailnet>.ts.net`.
6. In the Tailscale admin console, disable key expiry for the `fridgedoor` machine (step 6 of the [Tailscale instructions](home-server.md#option-a-tailscale)).

To print the setup link again, open the `fridgedoor` container and go to **Terminal** (or **Action > Open terminal**). Create a `sh` session and run `fridgedoor setup-link`.

**Upgrades:** stop the project, then choose **Action > Build** (or **Clean** then **Build**) so it pulls the newest image.

**Backups:** Hyper Backup or Snapshot Replication can back up `docker/fridgedoor/data`, which includes `secret.key`. For a guaranteed-consistent database copy, first run `fridgedoor backup` in the container terminal. It writes a copy to `data/backups/`.

## Unraid

Unraid runs Docker on Intel and AMD machines.

**Using the Docker tab (no plugins):**

1. Open **Docker** and click **Add Container**.
2. Fill in:
   - Name: `fridgedoor`
   - Repository: `ghcr.io/ravimody/fridgedoor:latest`
   - Network Type: `Bridge`
3. Click **Add another Path, Port, Variable...** and add:
   - **Path:** container path `/data`, host path `/mnt/user/appdata/fridgedoor`
   - **Port:** container port `8080`, host port `8080`
4. Click **Apply**. Open the container's log (click its icon, then **Logs**) to find the setup link.

**For HTTPS**, choose one of these:

- **Unraid 7's built-in Tailscale option.** In the container settings, turn on **Use Tailscale** and enable Serve or Funnel for port 8080. We haven't tested this option with Fridgedoor.
- **The Docker Compose Manager plugin** (from Community Applications) with the [compose file above](#a-compose-file-for-nas-apps). Change `./data` to `/mnt/user/appdata/fridgedoor`.

The setup link is also available from the container's **Console**: run `fridgedoor setup-link`.

**Upgrades:** on the Docker tab, click **Check for Updates**, then **Apply Update**.

**Backups:** back up `/mnt/user/appdata/fridgedoor`. The Appdata Backup plugin can do this. Run `fridgedoor backup` in the console first for a consistent database copy.

## TrueNAS SCALE (Community Edition 24.10 or later)

TrueNAS 24.10 "Electric Eel" and later run apps with Docker and accept custom Compose YAML.

1. Create a dataset for Fridgedoor, for example `tank/apps/fridgedoor`. Inside it, create `data` and `tailscale` folders. Copy `tailscale-serve.json` into it.
2. Open **Apps > Discover Apps**. Open the **...** menu and choose **Install via YAML**.
3. Name the app `fridgedoor` and paste the [compose file above](#a-compose-file-for-nas-apps). Replace each `./` with the full dataset path, for example:
   - `/mnt/tank/apps/fridgedoor/data:/data`
   - `/mnt/tank/apps/fridgedoor/tailscale:/var/lib/tailscale`
   - `/mnt/tank/apps/fridgedoor/tailscale-serve.json:/config/serve.json:ro`
4. Save. The app starts.
5. Find the setup link in the app's logs, or open a shell in the `fridgedoor` container and run `fridgedoor setup-link`.

**Upgrades:** use the app's **Update** button if TrueNAS offers one, or edit the app and save it again to pull the newest image.

**Backups:** take snapshots of the dataset and replicate them elsewhere. Run `fridgedoor backup` first for a consistent database copy.

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Install the iPhone app](../iphone.md)
- Back to [choosing a host](README.md)
