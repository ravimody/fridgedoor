# Run Fridgedoor on Render

Render runs Fridgedoor for about $7.25/month and gives it an HTTPS address like `https://fridgedoor.onrender.com`. Everything is done by clicking in the dashboard.

You need a paid instance. Render's free web services go to sleep after 15 minutes and can't have a disk, so Fridgedoor would stop reading email and lose its data.

Cost: about $7.25/month, made up of $7 for the smallest paid compute plan (0.5 CPU, 512 MB, plan id `0.5c-512mb`, formerly called Starter) and about $0.25 for a 1 GB disk. Prices as of October 2026. Check <https://render.com/pricing>.

## Option 1: Blueprint (uses the repository's `render.yaml`)

The `render.yaml` file in the Fridgedoor repository describes the `ghcr.io/ravimody/fridgedoor:latest` image, the `0.5c-512mb` plan, a health check, and a 1 GB disk mounted at `/data`. It also sets `TRUST_PROXY=true` and `CLIENT_IP_HEADER=CF-Connecting-IP`, because Render's traffic arrives through Cloudflare. That way sign-in rate limits see each visitor's own address.

1. Fork <https://github.com/ravimody/fridgedoor> to your own GitHub account.
2. In the Render dashboard, click **New > Blueprint**. Connect GitHub and pick your fork, give the Blueprint a name, and keep the `main` branch.
3. Render shows the `fridgedoor` web service and its disk. Click **Deploy Blueprint**. Add a payment method if asked.

## Option 2: By hand

1. Click **New > Web Service** and choose **Existing Image**. Enter `ghcr.io/ravimody/fridgedoor:latest` and click **Connect**.
2. Pick a region and the smallest paid instance type ($7/month).
3. Under **Advanced**:
   - Add a **Disk** with mount path `/data` and size 1 GB.
   - Set the **Health Check Path** to `/healthz`.
   - Add the environment variables `TRUST_PROXY` = `true` and `CLIENT_IP_HEADER` = `CF-Connecting-IP`. Visitors reach the app through Render's proxy, and without these one person's failed sign-ins can lock out the whole household.
4. Create the web service.

## Find the setup link

Open the service's **Logs** and look for "Open this link to create your household". Fridgedoor detects its `onrender.com` address automatically.

To print the link again, open the service's **Shell** tab and run:

```sh
fridgedoor setup-link
```

To set AI settings as environment variables instead of in the web app, add `AI_PROVIDER`, `AI_API_KEY` and so on under **Environment**, then choose **Save and deploy**. See [AI providers](../ai-providers.md).

## Custom domain

1. In the service's **Settings**, find **Custom Domains** and add your name, for example `fridgedoor.yourdomain.com`.
2. Add the DNS record Render shows (usually a CNAME to your `onrender.com` address). Render issues the certificate.
3. Under **Environment**, add `PUBLIC_URL=https://fridgedoor.yourdomain.com` and choose **Save and deploy**.

## Upgrades

After a new Fridgedoor release, click **Manual Deploy > Deploy latest reference** to pull the newest `latest` image. The app is down for a few seconds during each deploy, because only one instance can use the disk. **Restart service** doesn't pull a new image.

## Backups

Render snapshots the disk automatically every day and keeps snapshots for at least 7 days. You can restore one from the disk's settings. Restoring replaces the whole disk.

For a copy off Render:

1. Open the **Shell** tab and run `fridgedoor backup`. It writes a consistent copy to `/data/backups/`.
2. Copy that file and `/data/secret.key` to your computer. Render supports `scp` once you add an SSH key under **Account Settings > SSH Public Keys**. Get the SSH address from the service's **Connect > SSH** tab.

We haven't confirmed that SSH works with Fridgedoor's image on Render. If it doesn't, rely on Render's snapshots.

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Put Fridgedoor on your phones](../iphone.md)
- Back to [choosing a host](README.md)
