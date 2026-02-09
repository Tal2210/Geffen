#!/bin/bash

# Test script for Wine Search API
# Usage: ./test-search.sh

echo "🍷 Testing Wine Search API..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

API_URL="${API_URL:-http://localhost:3000}"

# Test 1: Health Check
echo -e "${BLUE}Test 1: Health Check${NC}"
curl -s "$API_URL/health" | jq '.'
echo ""

# Test 2: Simple Search
echo -e "${BLUE}Test 2: Simple Search - 'red wine'${NC}"
curl -s -X POST "$API_URL/search" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test_key_store_a" \
  -d '{
    "query": "red wine",
    "merchantId": "store_a",
    "limit": 5
  }' | jq '.metadata'
echo ""

# Test 3: Search with Filters
echo -e "${BLUE}Test 3: Search with Filters - 'wine from france under 50'${NC}"
curl -s -X POST "$API_URL/search" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test_key_store_a" \
  -d '{
    "query": "wine from france under 50",
    "merchantId": "store_a",
    "maxPrice": 50,
    "limit": 5
  }' | jq '.metadata'
echo ""

# Test 4: Hebrew Query
echo -e "${BLUE}Test 4: Hebrew Query - 'יין אדום מתוק'${NC}"
curl -s -X POST "$API_URL/search" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test_key_store_a" \
  -d '{
    "query": "יין אדום מתוק",
    "merchantId": "store_a",
    "limit": 5
  }' | jq '.metadata'
echo ""

# Test 5: Rate Limiting
echo -e "${BLUE}Test 5: Check Rate Limit Headers${NC}"
curl -s -I -X POST "$API_URL/search" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test_key_store_a" \
  -d '{"query": "wine", "merchantId": "store_a"}' | grep -i "x-ratelimit"
echo ""

# Test 6: Invalid API Key
echo -e "${BLUE}Test 6: Invalid API Key (should fail)${NC}"
curl -s -X POST "$API_URL/search" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: invalid_key" \
  -d '{"query": "wine", "merchantId": "store_a"}' | jq '.'
echo ""

echo -e "${GREEN}✅ Tests completed!${NC}"
