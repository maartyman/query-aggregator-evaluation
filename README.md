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
| File cache | `..._file-cache` | Client executes the query locally with a file-backed resource cache. Comunica still parses and indexes the cached RDF documents during query execution. |
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
