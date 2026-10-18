# Run Fridgedoor on Fly.io

Fly.io runs Fridgedoor on a small always-on machine with a disk, for about $4/month, and gives it an HTTPS address like `https://fridgedoor-yourname.fly.dev`. Every step uses the `fly` command-line tool, which makes Fly a good fit for AI coding agents.

Cost: about $4/month, made up of $3.69 for a 512 MB machine and $0.15 for a 1 GB disk. New accounts get a short free trial (2 hours of machine time or 7 days, whichever ends first), so you'll need to add a card to keep Fridgedoor running. Prices as of October 2026. Check <https://fly.io/docs/about/pricing/>.

## Steps

1. Install `flyctl` (see <https://fly.io/docs/flyctl/install/>) and sign in:

   ```sh
   fly auth login
   ```

2. Get Fridgedoor's `fly.toml`. It already turns off auto-stop (so the background worker keeps running), mounts the disk at `/data`, and adds a health check. It also sets `TRUST_PROXY = "true"` and `CLIENT_IP_HEADER = "Fly-Client-IP"`, so sign-in rate limits see each visitor's own address instead of Fly's proxy.

   ```sh
   mkdir fridgedoor && cd fridgedoor
   curl -fsSLO https://raw.githubusercontent.com/ravimody/fridgedoor/main/fly.toml
   ```

   You can also run the commands below from a clone of the repository.

3. Create the app without deploying it yet. App names are global on Fly, so pick a unique one in place of `fridgedoor-yourname`:

   ```sh
   fly launch --copy-config --no-deploy --name fridgedoor-yourname
   ```

   If it offers to change settings, you can say no. The region in `fly.toml` is `iad` (Virginia). To use a region near you, change `primary_region` (see `fly platform regions`) and use the same region in the next step.

4. Create the disk in the same region as the app:

   ```sh
   fly volumes create fridgedoor_data --size 1 --region iad
   ```

   Fly warns that a single volume has no redundancy. Answer yes. Fly takes daily snapshots of the volume (kept for 5 days), and you can make your own backups (below).

5. Deploy:

   ```sh
   fly deploy
   ```

6. Find the setup link in the logs:

   ```sh
   fly logs
   ```

   Look for "Open this link to create your household". To print it again at any time:

   ```sh
   fly ssh console -C "fridgedoor setup-link"
   ```

   Open the link in your browser. Fridgedoor detects its `https://<app>.fly.dev` address automatically.

## Optional: set AI settings as secrets

You can choose your AI provider in the web app during setup. To set it from the command line instead:

```sh
fly secrets set AI_PROVIDER=anthropic AI_API_KEY=sk-ant-...
```

Fly restarts the app when secrets change. When `AI_PROVIDER` is set this way, the web app shows the AI settings as read-only. See [AI providers](../ai-providers.md).

## Custom domain

1. Add the certificate:

   ```sh
   fly certs add fridgedoor.yourdomain.com
   ```

2. Add the DNS records it prints at your domain's DNS provider. To see them again, run `fly certs setup fridgedoor.yourdomain.com`. Each app has its own CNAME target, so copy it from that output rather than guessing.
3. Wait until `fly certs check fridgedoor.yourdomain.com` says the certificate is ready.
4. Tell Fridgedoor its new address. Fly restarts the app when you change this secret:

   ```sh
   fly secrets set PUBLIC_URL=https://fridgedoor.yourdomain.com
   ```

## Upgrades

```sh
fly deploy
```

This pulls the `latest` image, which changes when a new version is released, and restarts Fridgedoor. Expect a few seconds of downtime, because only one machine can use the disk.

## Backups

Make a consistent copy of the database, then download it with `secret.key`. You need both to restore.

```sh
fly ssh console -C "fridgedoor backup"
fly ssh console -C "ls /data/backups"
fly sftp get /data/backups/<file name from the list> ./
fly sftp get /data/secret.key ./secret.key
```

Keep `secret.key` somewhere private. It unlocks the saved email passwords and AI keys.

## Troubleshooting

- The app stops after a while. Check that `fly.toml` still has `auto_stop_machines = "off"`, then run `fly deploy`.
- "Out of memory" in the logs. Raise the memory to 1 GB with `fly scale memory 1024`. This costs more.

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Put Fridgedoor on your phones](../iphone.md)
- Back to [choosing a host](README.md)
