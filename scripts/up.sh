#!/usr/bin/env bash
# Build both images, load them into the kind cluster, and install everything with Helm.
# Usage: scripts/up.sh [--no-build]
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER=orders
TAG=${TAG:-dev}

kind get clusters | grep -qx "$CLUSTER" || kind create cluster --config deploy/kind.yaml
kubectl config use-context "kind-$CLUSTER" >/dev/null

if [[ "${1:-}" != "--no-build" ]]; then
  docker build -t "orders-platform-orders:$TAG" -f orders/Dockerfile .
  docker build -t "orders-platform-inventory:$TAG" -f inventory/Dockerfile .
fi
# Infrastructure images are pulled once on the host and side-loaded, which is
# much faster than every node pulling them.
INFRA=(apache/kafka:4.3.1 postgres:17-alpine jaegertracing/all-in-one:1.62.0)
# They are multi-platform, so only this machine's platform is exported:
# kind cannot import layers for platforms that were never pulled.
PLATFORM="linux/$(docker version -f '{{.Server.Arch}}')"
ARCHIVE=$(mktemp)
trap 'rm -f "$ARCHIVE"' EXIT
for image in "${INFRA[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q --platform "$PLATFORM" "$image"
  docker save --platform "$PLATFORM" -o "$ARCHIVE" "$image"
  kind load image-archive --name "$CLUSTER" "$ARCHIVE"
done
kind load docker-image --name "$CLUSTER" "orders-platform-orders:$TAG" "orders-platform-inventory:$TAG"

helm upgrade --install platform charts/platform --wait --timeout 5m
helm upgrade --install inventory charts/service -f deploy/values-inventory.yaml --set image.tag="$TAG" --wait --timeout 5m
helm upgrade --install orders charts/service -f deploy/values-orders.yaml --set image.tag="$TAG" --wait --timeout 5m

kubectl get pods -o wide
echo "Orders API: http://localhost:8090   Jaeger: http://localhost:16688"
