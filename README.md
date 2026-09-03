# query-aggregator-evaluation

Evaluation of the query aggregator (https://github.com/SolidLabResearch/aggregator) using the Watch Party and Elevate use cases.

The benchmark compares the same application-level queries across different authorization modes and execution modes. Each configured use-case iteration is executed for every enabled authorization mode and for the execution modes supported by that use case.

## prerequisites
- nodejs > 20
```
wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
source ~/.bashrc
nvm install v24
```
- docker
```
sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```
- kind
```
[ $(uname -m) = x86_64 ] && curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.30.0/kind-linux-amd64
chmod +x ./kind
sudo mv ./kind /usr/local/bin/kind
```
- kubectl
```
curl -LO "https://dl.k8s.io/release/v1.34.0/bin/linux/amd64/kubectl"
chmod +x kubectl
sudo mv kubectl /usr/local/bin/kubectl
```
- golang
```
curl -LO https://go.dev/dl/go1.25.4.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.25.4.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc
```

## installation

### Install css + uma:
```
cd ./user-managed-access
corepack enable
yarn install
yarn build
yarn start
```

### Install aggregator:
```
cd ./aggregator
make kubernettes-init
```

## run experiment

```
npm install
npm run build
npm start
```

For a smoke test without warmup and with one measured run per benchmark:

```
WARMUP_RUNS=0 RECORDED_RUNS=1 npm start
```

### Solution timeout

Each solution (local, local indexed, aggregator and aggregator discovered) is evaluated under a
per-run wall-clock timeout. If a single measured run of a solution takes longer than the timeout,
that run is stopped, all of the solution's other runs are discarded, and the solution as a whole is
recorded as timed out (`timedOut: true` in the result JSON) instead of producing timing data.

The timeout defaults to 10 seconds and can be changed with `SOLUTION_TIMEOUT_MS` (milliseconds):

```
SOLUTION_TIMEOUT_MS=10000 npm start
```

### Run distributed

The experiment node can start UMA/CSS and the aggregator on remote machines over SSH by adding a
`distributed` block to the experiment config. See `configs/distributed.example.json`.

For your current machines:

```json
"distributed": {
  "enabled": true,
  "aggregator": {
    "ssh": "ubuntu@10.10.222.238",
    "host": "10.10.222.238",
    "port": 5000,
    "repoPath": "/home/ubuntu/query-aggregator-evaluation"
  },
  "umaCss": {
    "ssh": "ubuntu@10.10.221.160",
    "host": "10.10.221.160",
    "umaPortBase": 4000,
    "solidPortBase": 3000,
    "repoPath": "/home/ubuntu/query-aggregator-evaluation",
    "dataRoot": "/home/ubuntu/query-aggregator-evaluation/experiment-data"
  }
}
```

Run it from the experiment node:

```bash
npm start -- --config configs/distributed.example.json
```

The experiment node will generate data locally, copy it to the UMA/CSS node with `rsync`, start UMA
and CSS on `10.10.221.160`, start the aggregator on `10.10.222.238`, wait for readiness logs, run
the benchmark, and stop the remote processes during cleanup/retry. The remote machines must already
have this repository, dependencies, Go/Node/Yarn, Docker/KinD/Kubernetes for the aggregator, and
working SSH access from the experiment node.

### Dedicated aggregator stack

By default (`AGGREGATOR_DEDICATED_STACK=true`), the aggregator evaluates against a separate, 
identical CSS and UMA stack to avoid server-side contention: expensive queries on the primary stack 
do not pollute auth timings for the aggregator, which uses its own isolated servers.

In local mode, a second UMA/CSS stack starts on distinct port ranges (solid 6000+i, uma 7000+i). 
The aggregator uses this stack (via its own PodContext) while local experiments use the primary 
stack (solid 3000+i, uma 4000+i).

In distributed mode, the aggregator machine runs both the Go aggregator AND a mirrored, identical 
CSS/UMA stack (also solid 3000+i, uma 4000+i on that machine). The aggregator's pod data is copied 
via `rsync` and rewritten to point to the aggregator-machine servers, achieving full isolation.

To revert to the legacy shared-stack behavior (one stack for both local and aggregator), set:

```bash
AGGREGATOR_DEDICATED_STACK=false npm start
```

For distributed mode, configure aggregator-machine CSS/UMA ports in the config's `aggregator` block 
(defaults: `solidPortBase: 3000, umaPortBase: 4000, dataRoot` required). See 
`configs/distributed.example.json`.

## benchmark dimensions

### Authorization modes

The target benchmark matrix has three authorization modes:

| Mode | Meaning |
| --- | --- |
| `no-auth` | Resources are registered at the AS but authorized by `AllAuthorizer`, so CSS/aggregator still ask the AS during ticket creation and receive a 2xx/no-ticket response. Local measured reads use plain `fetch`. |
| `nondelegated` | UMA authorization using `user-managed-access/packages/uma/config/nondelegated.json`, with immediate authorization. |
| `delegated` | UMA authorization using `user-managed-access/packages/uma/config/delegated.json`, where the UMA server uses delegated authorization/claim handling. |

The current implementation runs `no-auth`, `nondelegated`, and `delegated` automatically when an experiment does not pin `authorizationModes` in `configs/complete-config.json`.

### Execution modes

Each authorization mode should be crossed with the execution modes below.

| Mode | Result naming | Meaning |
| --- | --- | --- |
| No cache | `..._no-cache` | Client executes the query locally and fetches resources directly. |
| Indexed cache | `..._indexed-cache` | Client first loads the relevant sources into an in-memory `n3.Store`, then runs the local Comunica query against that store. |
| Aggregator | `..._aggregator` | Client uses a pre-created aggregator service directly. |
| Aggregator discovery | `..._aggregator_discovered` | Client does not know the aggregator service upfront. It discovers candidate services from CSS Link/LDP discovery metadata, fetches service descriptions, matches the needed query, then invokes the selected aggregator service. |

The indexed-cache mode is client-side only and is not used for aggregator execution.

## benchmarks

The active benchmark set is configured in `configs/complete-config.json`.

| Config key | Type | Iteration variable |
| --- | --- | --- |
| `wp-overview-experiment` | Watch Party overview page | Number of joined watch parties. |
| `wp-messages-experiment` | Watch Party watch page | Number of members and number of messages per member. |
| `el-activity-experiment` | Elevate activity page | Activity complexity: `minimal`, `simple`, `normal`, `complex`. |
| `el-overview-minimal-experiment` | Elevate activities overview | Number of activities with minimal selected fields. |
| `el-overview-normal-experiment` | Elevate activities overview | Number of activities with normal selected fields. |
| `el-overview-complex-experiment` | Elevate activities overview | Number of activities with complex selected fields. |
| `el-fitness-trend-experiment` | Elevate fitness trend page | Number of activities for the fitness trend view. |
| `el-yearly-progression-experiment` | Elevate yearly progression page | Number of activities for the yearly progression view. |

For each benchmark result, the saved JSON includes metadata such as `experimentName`, `experimentType`, `authorizationMode`, `delegatedAuth`, `podsPerServer`, warmup/recorded run counts, execution type, cache strategy, and run index.

## use cases

The two use cases evaluated by this repository are Watch Party (https://github.com/SolidLabResearch/solid-watch-party) and a sporting app called Elevate (https://github.com/SolidLabResearch/elevate).

### Watch Party

Two queries are expected to cause issues in this use case. First, if a user has followed a lot of streams/watch parties, the overview page has to find all these watch parties. Second, if a lot of users have a few messages in a watch party, or if a few people have a lot of messages, the watch page has to collect message and participant data across many pods.

### Elevate

The Elevate benchmarks cover individual activity reads and overview-style pages that aggregate multiple activities. The overview variants change the selected fields and number of activities so the benchmark can compare simple projections against broader, more expensive query shapes.
