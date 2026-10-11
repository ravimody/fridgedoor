# Run Fridgedoor on Railway

Railway runs Fridgedoor for you and gives it an HTTPS address like `https://fridgedoor-production.up.railway.app`. You can do it all by clicking in the dashboard, or with the `railway` command-line tool.

**Cost:** the Hobby plan is $5/month, and that includes $5 of usage. Fridgedoor's always-on service plus a small volume fits inside it, so expect about $5/month in total. The free trial's one-time credit runs out quickly, and the free plan after it is too small for an always-on app. Prices as of October 2026. Check <https://railway.com/pricing>.

## Steps in the dashboard

1. Sign up at <https://railway.com> and choose the **Hobby** plan.
2. Click **New Project**, choose **Docker Image**, and enter `ghcr.io/ravimody/fridgedoor:latest`.
   - You can also choose **GitHub Repository** with your fork of Fridgedoor. Railway then builds from the `Dockerfile` using `railway.json`, which is slower but lets you deploy changes you've made.
3. **Add a volume.** Right-click the service (or use the command palette) and choose **Add Volume**. Set the mount path to `/data`.
4. **Generate a domain.** Open the service's **Settings > Networking** and click **Generate Domain**. If Railway asks for a port, look in the logs for "Fridgedoor is listening on port ..." and use that number (normally `8080`).
5. **Check the service settings:**
   - Keep the replica count at 1.
   - Leave **Serverless** (app sleeping) turned off, so the background worker keeps running.
6. **Redeploy** so Fridgedoor picks up its new address: open the latest deployment's **...** menu and click **Redeploy**.
7. **Find the setup link.** Open the deployment's logs and look for "Open this link to create your household". Open it in your browser.

## Steps with the CLI

Install the CLI (see <https://docs.railway.com/guides/cli>), then run:

```sh
railway login
railway init --name fridgedoor
railway add --image ghcr.io/ravimody/fridgedoor:latest --service fridgedoor
railway volume add --mount-path /data --service fridgedoor
railway domain --service fridgedoor
railway redeploy --service fridgedoor
railway logs --service fridgedoor
```

To print the setup link again at any time:

```sh
railway ssh --service fridgedoor -- fridgedoor setup-link
```

To set AI settings from the command line instead of in the web app, add:

```sh
railway variable set AI_PROVIDER=openai AI_API_KEY=sk-... --service fridgedoor
```

See [AI providers](../ai-providers.md).

## Custom domain

1. In the service's **Settings > Networking**, click **Custom Domain** and type your name, for example `fridgedoor.yourdomain.com`.
2. Add the DNS records Railway shows at your DNS provider.
3. Once the domain shows as active, set a variable so Fridgedoor uses the new address. Railway redeploys automatically.

   ```
   PUBLIC_URL=https://fridgedoor.yourdomain.com
   ```

## Upgrades

Pick one of these:

- **Automatic.** Railway can update images from GitHub Container Registry for you. Turn on image auto updates in the service's settings and choose a maintenance window. Railway backs up the volume before each update. It can take a few hours to notice a new version.
- **Right now.** Open the command palette (Ctrl+K or Cmd+K) and run **Redeploy source image** for the Fridgedoor service.
- **From a repository.** If you deployed from your GitHub fork, sync the fork and Railway rebuilds.

Expect a few seconds of downtime, because the volume can only be attached to one running copy.

## Backups

Make a consistent copy of the database, then download it with `secret.key`. You need both to restore.

```sh
railway ssh --service fridgedoor -- fridgedoor backup
railway volume files download /backups ./fridgedoor-backups
railway volume files download /secret.key ./fridgedoor-backups/secret.key
```

Paths in `railway volume files` start at the volume itself, so `/backups` is `/data/backups` inside the app. If the CLI asks which volume, choose the one mounted at `/data`.

Keep `secret.key` somewhere private. It unlocks the saved email passwords and AI keys.

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Install the iPhone app](../iphone.md)
- Back to [choosing a host](README.md)
