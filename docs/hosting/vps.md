# Run Fridgedoor on a VPS or cloud VM

A VPS (virtual private server) is a small Linux computer you rent in a data center. Fridgedoor runs well on one with 1 GB of memory. This page starts with the general steps, which work at any provider, then gives specific clicks and commands for each provider.

Prices as of October 2026. Check the provider's pricing page before you sign up.

## The general steps

### 1. Create the VM

- **Operating system:** Ubuntu 24.04 LTS. Either Intel/AMD (x86-64) or Arm (aarch64) is fine.
- **Size:** at least 1 GB of memory. 2 GB is more comfortable. The setup adds swap space on small machines.
- **Disk:** the provider's default (usually 25 GB or more) is plenty.
- **SSH key:** add one if the provider asks, so you can log in later.

### 2. Install Fridgedoor

First choose how phones reach it (see [HTTPS explained](https.md)):

- **A domain name** (`domain`). Caddy, a web server bundled with Fridgedoor, gets a free HTTPS certificate automatically. You need:
  - ports 80 and 443 open to the internet
  - a DNS record pointing your name at the VM's IP address (see [step 3](#3-point-a-domain-name-at-the-vm))

  If you don't own a domain, a [free DuckDNS name](#free-domain-name-with-duckdns) works.
- **Tailscale** (`tailscale`). You don't need to open any ports or own a domain. See [the Tailscale steps](home-server.md#option-a-tailscale) for the auth key and the Funnel setting.

Then install Fridgedoor in one of two ways.

**Way 1: paste the cloud-init file when you create the VM.** Most providers have a box called "user data", "cloud-init" or "initialization script".

1. Open [`deploy/cloud-init.yaml`](https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/cloud-init.yaml) and copy it.
2. Edit the last line before pasting it. For a domain, change `fridgedoor.example.com` to your name:

   ```yaml
     - [sh, -c, 'FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=domain DOMAIN=fridgedoor.example.com bash /root/fridgedoor-install.sh > /var/log/fridgedoor-install.log 2>&1']
   ```

   For Tailscale, use this line instead:

   ```yaml
     - [sh, -c, 'FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=tailscale TS_AUTHKEY=tskey-auth-... bash /root/fridgedoor-install.sh > /var/log/fridgedoor-install.log 2>&1']
   ```

3. Paste it into the user-data box.
4. Create the VM and wait a few minutes. Then log in and read the setup link:

   ```sh
   sudo tail /var/log/fridgedoor-install.log
   ```

**Way 2: log in and run the installer.**

```sh
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh | sudo bash
```

It asks how phones should reach Fridgedoor and prints the setup link at the end. Fridgedoor's files go in `/opt/fridgedoor`.

To print the setup link again later:

```sh
cd /opt/fridgedoor && sudo docker compose exec fridgedoor fridgedoor setup-link
```

### 3. Point a domain name at the VM

You can skip this step if you use Tailscale.

1. At the company you bought your domain from, add an **A record**:
   - Name: `fridgedoor`
   - Value: the VM's public IPv4 address
2. If the VM has an IPv6 address, also add an **AAAA record** for it.
3. Open ports **80 and 443** in the provider's firewall. The provider sections below show where.

It's fine to create the DNS record right after the VM starts. Caddy keeps retrying until the name works, then gets its certificate. Some providers change a VM's IP address when it's stopped. On those, reserve a static IP (see the provider notes).

### Free domain name with DuckDNS

[DuckDNS](https://www.duckdns.org) gives you a free name like `ourfamily.duckdns.org`.

1. Sign in at duckdns.org (with Google, GitHub and others).
2. Add a subdomain.
3. Type the VM's IP address in the **current ip** box and click **update ip**.
4. Use `DOMAIN=ourfamily.duckdns.org` with the `domain` option.

The built-in Caddy setup works with DuckDNS as long as ports 80 and 443 are open. DuckDNS is run by volunteers and sometimes has outages. A domain of your own (about $10/year) is more dependable.

### Upgrades and backups

From `/opt/fridgedoor`, using the same profile you installed with:

```sh
sudo docker compose pull && sudo docker compose --profile caddy up -d
```

Use `--profile tailscale` if you installed with Tailscale. Re-running the installer also upgrades.

For backups, follow [the home-server backup steps](home-server.md#backups). Then copy the `backups` folder to your own computer. For example, from your computer:

```sh
scp -r ubuntu@<vm-ip>:/opt/fridgedoor/backups ./fridgedoor-backups
```

The `backups` folder belongs to root after `docker compose cp`. If `scp` can't read it, run `sudo chown -R $USER /opt/fridgedoor/backups` on the VM first.

## Free options

### Oracle Cloud Always Free

Oracle gives every account a free Arm server that doesn't expire. This is the only big-cloud VM that is truly free with plenty of memory. Be aware of these limits:

- **Size.** The free Arm (Ampere A1) allowance is 2 CPUs and 12 GB of memory in total. Oracle halved it in 2026. Fridgedoor needs a fraction of that.
- **"Out of host capacity" errors.** Popular regions often have no free Arm servers available. You choose your home region at signup and can't change it later. Oracle suggests retrying later or trying another availability domain. Upgrading the account to Pay As You Go also helps; Always Free resources stay free on Pay As You Go.
- **Idle reclamation.** Oracle may reclaim an Always Free server that looks idle for 7 days. "Idle" means CPU, network and memory use all stay under 20%. A small server (1 CPU, 2 GB) running Fridgedoor uses enough memory to look busy, but there's no guarantee. Keep backups off the machine.
- **Idle accounts.** Oracle may treat an account nobody has signed in to for 30 days as abandoned. Sign in to the console now and then.
- **Signup.** You need a real credit or debit card for identity checks. Prepaid and virtual cards aren't accepted. You can have one account per person.

Steps:

1. Sign up at <https://www.oracle.com/cloud/free/>.
2. Open **Compute > Instances** and click **Create instance**.
3. **Image and shape.**
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: click **Change shape**, choose **Ampere**, then **VM.Standard.A1.Flex**. Set **1 OCPU** and **2 GB** memory.
4. **Networking:** create a new virtual cloud network with a public subnet, and assign a public IPv4 address.
5. **SSH keys:** download the generated private key, or paste your own public key.
6. **User data:** click **Show advanced options**, open the **Management** tab, choose **Paste cloud-init script**, and paste your edited `cloud-init.yaml`.
7. Click **Create**. If you get "Out of capacity", try another availability domain or retry later. As a last resort, use the free **VM.Standard.E2.1.Micro** shape (Intel/AMD, 1 GB, slow but enough).
8. **For a domain only, open ports 80 and 443.** Oracle has two firewalls, and both must allow the traffic.
   1. In the console, open **Networking > Virtual cloud networks**, then your network, then **Security Lists** (under Security). Open the **Default Security List** and click **Add Ingress Rules**:
      - Source CIDR: `0.0.0.0/0`
      - IP protocol: TCP
      - Destination port range: `80`

      Add a second rule the same way for port `443`.
   2. Oracle's Ubuntu image also has its own firewall rules. Docker usually opens its ports itself. If the site still times out, SSH in (the user is `ubuntu`) and run:

      ```sh
      sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
      sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
      sudo netfilter-persistent save
      ```

9. Read the setup link with `sudo tail /var/log/fridgedoor-install.log`.

### Google Cloud e2-micro

Google gives one small server (e2-micro: 2 shared CPUs, 1 GB of memory) free every month, with no end date. The free tier covers it only in three US regions:

- `us-west1` (Oregon)
- `us-central1` (Iowa)
- `us-east1` (South Carolina)

It also includes 30 GB of standard disk. You need a card to sign up.

**The catch: the public IP address isn't free.** Google charges about $3.65/month for an external IPv4 address. Fridgedoor needs one to download its software, so expect a small bill. Check your first invoice.

Install the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), sign in, and select a project. Download `cloud-init.yaml` and edit its last line as described in [step 2](#2-install-fridgedoor). Then run:

```sh
gcloud services enable compute.googleapis.com

gcloud compute instances create fridgedoor \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --tags=fridgedoor-web \
  --metadata-from-file=user-data=cloud-init.yaml

# Only needed for the domain option: open ports 80 and 443.
gcloud compute firewall-rules create fridgedoor-web \
  --allow=tcp:80,tcp:443 --target-tags=fridgedoor-web

# Show the IP address (for your DNS record).
gcloud compute instances describe fridgedoor --zone=us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'

# Read the setup link a few minutes later.
gcloud compute ssh fridgedoor --zone=us-central1-a \
  --command='sudo tail /var/log/fridgedoor-install.log'
```

The IP address can change if the VM is stopped. To keep it, reserve it as a static address. It costs the same while in use:

```sh
gcloud compute addresses create fridgedoor-ip --region=us-central1 --addresses=<the IP>
```

Keep `--boot-disk-type=pd-standard` and 30 GB or less. Other disk types aren't covered by the free tier.

## Paid providers

### AWS: Lightsail and EC2

AWS no longer has a free server that lasts. Accounts created since July 15, 2025 get about $100-200 in credits on a "Free plan". The account closes after 6 months, or sooner if the credits run out, unless you upgrade to a paid plan.

**Lightsail** is AWS's simple VPS. The 1 GB plan with an IPv4 address costs about $7/month. The $5 plan has only 512 MB, which is too tight.

1. In the Lightsail console, click **Create instance**.
2. Choose **Linux/Unix**, then **OS Only**, then **Ubuntu 24.04 LTS**, and pick the 1 GB plan.
3. Create the instance.
4. Click **Connect using SSH** to open a terminal in your browser. Run the installer ([Way 2](#2-install-fridgedoor)).
5. On the instance's **Networking** tab:
   - Click **Attach static IP**. It's free while attached.
   - Under the IPv4 firewall, add a rule for **HTTPS (443)**. HTTP (80) is usually open already.

**EC2** works too, and suits people already using AWS.

1. Click **Launch instance** and choose **Ubuntu Server 24.04 LTS**.
2. Choose a type marked "Free tier eligible", for example `t4g.small` (Arm) or `t3.small`.
3. Under network settings, allow SSH, HTTP and HTTPS from the internet.
4. Paste `cloud-init.yaml` under **Advanced details > User data**.

The public IPv4 address costs about $3.65/month, taken from your credits. Use an Elastic IP if you need the address to survive stop/start.

### DigitalOcean

The Basic Droplet with 1 GB costs about $6/month. DigitalOcean has the friendliest console and docs. Its **App Platform** doesn't work for Fridgedoor (no persistent disk), so use a Droplet.

1. Click **Create > Droplets** and choose a region.
2. Choose **Ubuntu 24.04 (LTS) x64**, then **Basic**, **Regular**, and the $6 plan.
3. Add your SSH key.
4. Under **Advanced options**, check **Add initialization scripts** and paste `cloud-init.yaml`.
5. Create the Droplet. Droplets have no firewall by default, so ports 80 and 443 are already open.

With the `doctl` CLI:

```sh
doctl compute droplet create fridgedoor --region nyc3 --size s-1vcpu-1gb \
  --image ubuntu-24-04-x64 --ssh-keys <your key fingerprint> \
  --user-data-file cloud-init.yaml --wait
```

### Vultr

The 1 GB Cloud Compute plan (`vc2-1c-1gb`) costs about $5/month. The $2.50 and $3.50 plans are too small.

1. Click **Deploy** and choose **Cloud Compute - Shared CPU**.
2. Pick a location, **Ubuntu 24.04 LTS x64**, and the 1 GB plan.
3. Under **Additional Features**, enable **Cloud-Init User-Data** and paste `cloud-init.yaml`.

With `vultr-cli`, run `vultr-cli os list` to find the Ubuntu 24.04 ID, then:

```sh
vultr-cli instance create --region ewr --plan vc2-1c-1gb --os <ubuntu-24.04-id> \
  --host fridgedoor --userdata "$(cat cloud-init.yaml)"
```

### Linode (Akamai)

The Nanode 1 GB plan costs about $5/month and includes an IPv4 address.

1. Click **Create Linode** and choose **Ubuntu 24.04 LTS**.
2. Pick a region that shows the **Add User Data** option, then choose **Shared CPU > Nanode 1 GB**.
3. Set a root password and add your SSH key.
4. Under **Add User Data**, paste `cloud-init.yaml`.

With `linode-cli`:

```sh
linode-cli linodes create --label fridgedoor --region us-east --type g6-nanode-1 \
  --image linode/ubuntu24.04 --root_pass '<a long password>' \
  --authorized_keys "$(cat ~/.ssh/id_ed25519.pub)" \
  --metadata.user_data "$(base64 < cloud-init.yaml | tr -d '\n')"
```

### OVHcloud

VPS-1 costs about $5.35/month, or a little less if you prepay for a year. It has the most memory for the money: 4 GB. OVH has US data centers in Virginia and Oregon.

- The control panel is the clunkiest of this group.
- Avoid the "Local Zone" VPS plans, which don't support Docker.

1. Order a VPS-1 with **Ubuntu 24.04**.
2. OVH emails you the login details.
3. SSH in and run the installer ([Way 2](#2-install-fridgedoor)).
4. If you enabled OVH's network firewall, allow ports 80 and 443.

### Hetzner

Hetzner is a good deal in Europe, but not in the US anymore:

- **Europe:** CX23 (Intel/AMD, 4 GB) about €5.49/month, or CAX11 (Arm, 4 GB) about €5.99/month. A public IPv4 address costs about €0.50/month extra.
- **US:** only the CPX line is available, and the smallest (CPX11) is about $20.49/month after the June 2026 price rise.

As of October 2026, Hetzner's status page reports restrictions on creating new servers for new and some existing customers. Hetzner may also ask for ID or prepayment.

If you can get a server, the `hcloud` CLI is very scriptable:

```sh
hcloud server create --name fridgedoor --type cx23 --image ubuntu-24.04 \
  --location fsn1 --ssh-key <your key name> --user-data-from-file cloud-init.yaml
```

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Install the iPhone app](../iphone.md)
- Back to [choosing a host](README.md)
