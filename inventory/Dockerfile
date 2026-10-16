# Build context is the repository root, so the shared proto/ is available.
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src/inventory
COPY inventory/.mvn .mvn
COPY inventory/mvnw inventory/pom.xml ./
COPY proto /src/proto
COPY inventory/src src
# The Maven cache persists between builds, and downloads are retried, so a
# dropped connection costs one file rather than the whole build.
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw -B -q -Daether.connector.http.retryHandler.count=5 package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
ADD --checksum=sha256:f787eb6c7f3d18e69a431e108a15278d25ee37f83d68b678f621e063f3988f82 \
    https://repo1.maven.org/maven2/io/opentelemetry/javaagent/opentelemetry-javaagent/2.32.0/opentelemetry-javaagent-2.32.0.jar /app/otel-agent.jar
COPY --from=build /src/inventory/target/inventory-0.0.1-SNAPSHOT.jar /app/app.jar
RUN chmod 444 /app/otel-agent.jar
USER 10001
EXPOSE 8080 9090
# The OpenTelemetry agent traces gRPC, Kafka and JDBC without code changes.
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-javaagent:/app/otel-agent.jar", "-jar", "/app/app.jar"]
