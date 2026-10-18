# Run Fridgedoor on Railway

Railway runs Fridgedoor for about $5/month and gives it an HTTPS address like `https://fridgedoor-production.up.railway.app`. You can set it up by clicking in the dashboard, or with the `railway` command-line tool. The repository has no Railway config file (Railway has deprecated them), so every setting below is made in the dashboard or the CLI.

Cost: the Hobby plan is $5/month, and that includes $5 of usage. Fridgedoor's always-on service plus a small volume should fit inside it, so expect about $5/month in total. The free trial is a one-time $5 credit for 30 days, and the Free plan after it ($1 of credit a month) is too small for an always-on app. Trial volumes are deleted 30 days after the credit runs out unless you upgrade. Prices as of October 2026. Check <https://railway.com/pricing>.

## Steps in the dashboard

1. Sign up at <https://railway.com> and choose the **Hobby** plan.
2. Create a new project and add a service from a **Docker Image**. Enter `ghcr.io/ravimody/fridgedoor:latest`.
   - You can instead deploy your fork of Fridgedoor from a **GitHub Repository**. Railway then builds from the `Dockerfile`, which is slower but lets you deploy changes you've made.
3. Add a volume. Right-click the project canvas (or press Cmd+K or Ctrl+K), create a volume, attach it to the Fridgedoor service, and set the mount path to `/data`.
4. Generate a domain. Open the service's **Settings > Networking** and click **Generate Domain**. If Railway asks for a port, look in the logs for "Fridgedoor is listening on port ..." and use that number (normally `8080`).
5. Under **Variables**, add these two. Visitors reach the app through Railway's proxy, and without them one person's failed sign-ins can lock out the whole household.

   ```
   TRUST_PROXY=true
   CLIENT_IP_HEADER=X-Real-IP
   ```

6. In the service's **Settings**:
   - Under **Deploy**, set the **Healthcheck Path** to `/healthz` and the restart policy to **Always**.
   - Keep the replica count at 1.
   - Leave **Serverless** (app sleeping) turned off, so the background worker keeps running.
7. Redeploy so Fridgedoor picks up its new address and settings: open the latest deployment's **...** menu and click **Redeploy**.
8. Find the setup link. Open the deployment's logs and look for "Open this link to create your household". Open it in your browser.

## Steps with the CLI

Install the CLI (see <https://docs.railway.com/guides/cli>), then run:

```sh
railway login
railway init --name fridgedoor
railway add --image ghcr.io/ravimody/fridgedoor:latest --service fridgedoor
railway service fridgedoor
railway volume add --mount-path /data
railway domain --service fridgedoor
railway variable set TRUST_PROXY=true CLIENT_IP_HEADER=X-Real-IP --service fridgedoor --skip-deploys
railway redeploy --service fridgedoor -y
railway logs --service fridgedoor
```

Then set the health check and restart policy in the dashboard, as in step 6 above.

`railway service fridgedoor` links the folder to the service first, because as of October 2026 `railway volume add --service` crashes when given a service name instead of an ID.

To print the setup link again at any time:

```sh
railway ssh --service fridgedoor -- fridgedoor setup-link
```

To set AI settings from the command line instead of in the web app, run the following. Railway redeploys after the change.

```sh
railway variable set AI_PROVIDER=openai AI_API_KEY=sk-... --service fridgedoor
```

See [AI providers](../ai-providers.md).

## Custom domain

1. In the service's **Settings > Networking**, click **Custom Domain** and type your name, for example `fridgedoor.yourdomain.com`.
2. Add the DNS records Railway shows at your DNS provider.
3. Once the domain shows as active, add this variable to the service, then click **Deploy** to apply the staged change:

   ```
   PUBLIC_URL=https://fridgedoor.yourdomain.com
   ```

## Upgrades

Pick one of these:

- Automatic. Railway can update images from GitHub Container Registry for you. In the service's **Settings > Source**, choose **Configure Auto Updates** and pick a maintenance window. On the Pro plan, Railway also backs up the volume before each update. It can take a few hours to notice a new version.
- Right now. Open the command palette (Ctrl+K or Cmd+K) and run **Redeploy source image** for the Fridgedoor service.
- From a repository. If you deployed from your GitHub fork, sync the fork and Railway rebuilds.

Expect a few seconds of downtime, because a service with a volume can only run one copy.

## Backups

Make a consistent copy of the database, then download it with `secret.key`. You need both to restore. Run these from the folder you linked with `railway service fridgedoor`:

```sh
railway ssh --service fridgedoor -- fridgedoor backup
railway volume files download /backups ./fridgedoor-backups --overwrite
railway volume files download /secret.key ./fridgedoor-backups/secret.key --overwrite
```

Paths in `railway volume files` start at the volume itself, so `/backups` is `/data/backups` inside the app. If the CLI asks which volume, choose the one mounted at `/data`.

Keep `secret.key` somewhere private. It unlocks the saved email passwords and AI keys.

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Put Fridgedoor on your phones](../iphone.md)
- Back to [choosing a host](README.md)
