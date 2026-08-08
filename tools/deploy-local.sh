#!/usr/bin/env bash
# Builds employment-insurance-mfe's + employment-insurance-bff's images, spins
# up (or reuses) a local kind cluster with ingress-nginx, and
# helm-upgrades this app's chart onto it -- the local equivalent of the
# kind-validation stage in .github/workflows/ci.yml.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLUSTER_NAME="${CLUSTER_NAME:-kind}"
PLATFORM_DIR=../mfe-pot-platform
HOSTNAME=employment-insurance-mfe.mfe-pot.local

if [ ! -d "$PLATFORM_DIR" ]; then
  echo "error: expected mfe-pot-platform checked out as a sibling at $PLATFORM_DIR (see ../mfe-pot.code-workspace)" >&2
  exit 1
fi

NPM_TOKEN="${NODE_AUTH_TOKEN:-${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}}"
if [ -z "$NPM_TOKEN" ]; then
  echo "error: no GitHub token found. Set NODE_AUTH_TOKEN/GITHUB_TOKEN or run 'gh auth login' -- needed to pull @tn4consulting/* packages during the image build." >&2
  exit 1
fi
token_file="$(mktemp)"
trap 'rm -f "$token_file"' EXIT
printf '%s' "$NPM_TOKEN" > "$token_file"

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  echo "==> Creating kind cluster '$CLUSTER_NAME'..."
  kind create cluster --name "$CLUSTER_NAME" \
    --config "$PLATFORM_DIR/tools/k8s/kind-config.yaml" \
    --image kindest/node:v1.27.3
fi

if ! kubectl --context "kind-$CLUSTER_NAME" get ns ingress-nginx >/dev/null 2>&1; then
  echo "==> Installing ingress-nginx..."
  kubectl --context "kind-$CLUSTER_NAME" apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
  kubectl --context "kind-$CLUSTER_NAME" rollout status deployment/ingress-nginx-controller \
    --namespace ingress-nginx \
    --timeout=120s
fi

export DOCKER_BUILDKIT=1

echo "==> Building employment-insurance-mfe image..."
docker build \
  --secret id=npm_token,src="$token_file" \
  -t mfe-pot-employment-insurance-mfe:kind \
  -f apps/employment-insurance-mfe/Dockerfile .

echo "==> Building employment-insurance-bff image..."
docker build \
  --secret id=npm_token,src="$token_file" \
  -t mfe-pot-employment-insurance-bff:kind \
  -f apps/employment-insurance-bff/Dockerfile .

echo "==> Loading images into kind..."
kind load docker-image mfe-pot-employment-insurance-mfe:kind --name "$CLUSTER_NAME"
kind load docker-image mfe-pot-employment-insurance-bff:kind --name "$CLUSTER_NAME"

echo "==> Updating Helm chart dependencies..."
helm dependency update charts/employment-insurance-mfe

echo "==> Deploying employment-insurance-mfe..."
helm --kube-context "kind-$CLUSTER_NAME" upgrade --install employment-insurance-mfe charts/employment-insurance-mfe \
  -f charts/employment-insurance-mfe/values.yaml \
  -f charts/employment-insurance-mfe/values-kind.yaml \
  --wait --timeout 120s

# values-kind.yaml pins static image tags with pullPolicy: Never, so
# rebuilt images loaded above under the same tags don't change either
# Deployment's pod spec -- Helm sees no diff and Kubernetes has no signal
# to restart the already-running pods, which keep serving OLD image
# content indefinitely (confirmed the hard way: a redeploy silently kept
# serving a pre-fix build). Force both deployments explicitly every run.
echo "==> Restarting deployments to pick up the freshly built images..."
kubectl --context "kind-$CLUSTER_NAME" rollout restart deployment/employment-insurance-mfe deployment/employment-insurance-bff
kubectl --context "kind-$CLUSTER_NAME" rollout status deployment/employment-insurance-mfe --timeout=60s
kubectl --context "kind-$CLUSTER_NAME" rollout status deployment/employment-insurance-bff --timeout=60s

echo "==> Waiting for ingress..."
status=000
for i in $(seq 1 30); do
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOSTNAME" http://localhost/ || echo 000)
  [ "$status" = "200" ] && break
  sleep 2
done
if [ "$status" != "200" ]; then
  echo "warning: employment-insurance-mfe isn't answering with 200 yet (last status: $status). Check with:" >&2
  echo "  kubectl --context kind-$CLUSTER_NAME get pods,ingress" >&2
  exit 1
fi

echo "==> employment-insurance-mfe is up: curl -H \"Host: $HOSTNAME\" http://localhost/"
