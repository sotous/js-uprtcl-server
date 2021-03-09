#!/bin/bash
# Dgraph backup
# Please consider setting the ENV variable DGRAPH_DB_S3_BACKUP before running this script

name=$1

echo Getting docker containers $'\n\n'

DOCKER_CNT=$(docker ps --format "{{.Names}}")
ALPHA=""
ZERO=""

echo Docker services running: $DOCKER_CNT 

# Looks for the alpha name
for value in $DOCKER_CNT
do
    if [[ $value == *"alpha"* ]]; then
        ALPHA=$value
    fi
    if [[ $value == *"zero"* ]]; then
        ZERO=$value
    fi
done


echo inspecting: $ALPHA 
echo inspecting: $ZERO 

if (($ALPHA == "")); then
  printf '%s\n' "Alpha not found" >&2  # write error message to stderr
  exit 1                                
fi

if (($ZERO == "")); then
  printf '%s\n' "Zero not found" >&2  # write error message to stderr
  exit 1                                
fi

# Gets container ID of the alpha
ALPHA_ID=$(docker inspect --format="{{.Id}}" $ALPHA)
ZERO_ID=$(docker inspect --format="{{.Id}}" $ZERO)

echo Stopping alpha . . . $'\n\n'
docker stop $ALPHA_ID
echo Alpha stopped . . . $'\n\n'

# Step 2: Copy backups to docker container

LATEST=$(aws s3 ls $DGRAPH_DB_S3_BACKUP --recursive | sort | tail -n 1 | awk '{print $4}')
IFS='/'
read -a strarr <<< "$LATEST"
LATEST=${strarr[0]}

echo backing up: s3://$DGRAPH_DB_S3_BACKUP/$LATEST

aws s3 sync s3://$DGRAPH_DB_S3_BACKUP/$LATEST ~/dgraph/backup

echo Adding backup to docker container . . . $'\n\n'

docker cp ~/dgraph/backup $ZERO_ID:/dgraph/export

# Step 3: Execute bulk
BACKUP_FOLDER=$(ls backup)
rm -rf ~/dgraph/backup

echo Executing bulk load . . . ðŸ¤ž ðŸ™ $'\n\n'

docker exec -t $ZERO_ID dgraph bulk -f /dgraph/export/$BACKUP_FOLDER/g01.rdf.gz -s /dgraph/export/$BA$

# Step 4: Remove P directory from zero

echo Deleting old "p" directory from container . . . $'\n\n'

docker exec -t $ZERO_ID rm -rf p

echo Writing new data to container . . . $'\n\n'
# Step 5: Write content generated by bulk in single shard
docker exec -t $ZERO_ID cp -r ./out/0/p  ./p
docker exec -t $ZERO_ID rm -rf out
docker exec -t $ZERO_ID rm -rf ./export

# Step 6: Restart alpha cluster
echo Restarting alpha . . .  $'\n\n'
docker start --interactive $ALPHA
