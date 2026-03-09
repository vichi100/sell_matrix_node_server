#!/bin/bash
# SellMetrix VPS Infrastructure Setup Script
# Installs PostgreSQL, Redis, and MinIO (via Docker) on a Debian/Ubuntu VPS.

set -e

echo "================================================="
echo " Starting SellMetrix Infrastructure Installation "
echo "================================================="

# 1. Update packages
echo "\n[1/4] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# 2. Install PostgreSQL and Redis (Native for best performance)
echo "\n[2/4] Installing PostgreSQL and Redis..."
sudo apt-get install postgresql postgresql-contrib redis-server -y

# Enable and start services
sudo systemctl enable postgresql
sudo systemctl start postgresql
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Create db and user (Change password in production!)
echo "\nSetting up PostgreSQL User and Database..."
sudo -u postgres psql -c "CREATE DATABASE sellmetrix;" || true
sudo -u postgres psql -c "CREATE USER sm_admin WITH ENCRYPTED PASSWORD 'sm_secure_pass_123';" || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE sellmetrix TO sm_admin;" || true

# 3. Install Docker (for MinIO Object Storage)
echo "\n[3/4] Installing Docker..."
if ! command -v docker &> /dev/null; then
    sudo apt-get install docker.io -y
    sudo systemctl enable docker
    sudo systemctl start docker
else
    echo "Docker is already installed."
fi

# 4. Install & Run MinIO (S3 Compatible Object Storage)
echo "\n[4/4] Starting MinIO Container..."
# Create a local directory to persist MinIO data
sudo mkdir -p /mnt/sellmetrix_data
sudo chmod 777 /mnt/sellmetrix_data

# Run MinIO Docker Container
sudo docker run -d -p 9000:9000 -p 9001:9001 \
  --name minio-server \
  --restart unless-stopped \
  -e "MINIO_ROOT_USER=sm_admin" \
  -e "MINIO_ROOT_PASSWORD=sm_secure_pass_123" \
  -v /mnt/sellmetrix_data:/data \
  quay.io/minio/minio server /data --console-address ":9001" || true

echo "\n================================================="
echo " Installation Complete! "
echo "================================================="
echo "PostgreSQL: Running on localhost:5432 (DB: sellmetrix, User: sm_admin)"
echo "Redis:      Running on localhost:6379"
echo "MinIO API:  http://YOUR_VPS_IP:9000 (User: sm_admin)"
echo "MinIO UI:   http://YOUR_VPS_IP:9001"
echo "================================================="
echo "Next step: Run 'psql -U sm_admin -d sellmetrix -f scripts/schema.sql' to initialize the database."
