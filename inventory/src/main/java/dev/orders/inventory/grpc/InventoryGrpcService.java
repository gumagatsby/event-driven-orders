package dev.orders.inventory.grpc;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;

import dev.orders.inventory.grpc.v1.CheckAvailabilityRequest;
import dev.orders.inventory.grpc.v1.CheckAvailabilityResponse;
import dev.orders.inventory.grpc.v1.InventoryServiceGrpc;
import dev.orders.inventory.grpc.v1.LineAvailability;
import dev.orders.inventory.grpc.v1.ListProductsRequest;
import dev.orders.inventory.grpc.v1.ListProductsResponse;
import dev.orders.inventory.grpc.v1.Product;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * Read-only queries. Availability here is advisory: it lets the orders service
 * refuse an obviously impossible order straight away, but the reservation made
 * from the Kafka event is the one that counts.
 */
@Service
public class InventoryGrpcService extends InventoryServiceGrpc.InventoryServiceImplBase {

	private final JdbcClient db;

	public InventoryGrpcService(JdbcClient db) {
		this.db = db;
	}

	@Override
	public void listProducts(ListProductsRequest request, StreamObserver<ListProductsResponse> response) {
		List<Product> products = this.db
			.sql("SELECT sku, name, price_minor, on_hand - reserved FROM products ORDER BY sku")
			.query((rs, n) -> Product.newBuilder()
				.setSku(rs.getString(1))
				.setName(rs.getString(2))
				.setPriceMinor(rs.getLong(3))
				.setAvailable(rs.getInt(4))
				.build())
			.list();
		response.onNext(ListProductsResponse.newBuilder().addAllProducts(products).build());
		response.onCompleted();
	}

	@Override
	public void checkAvailability(CheckAvailabilityRequest request,
			StreamObserver<CheckAvailabilityResponse> response) {
		if (request.getLinesCount() == 0 || request.getLinesCount() > 100
				|| request.getLinesList().stream().anyMatch(l -> l.getSku().isBlank() || l.getQuantity() < 1)) {
			response.onError(Status.INVALID_ARGUMENT.withDescription("1 to 100 lines, each with a SKU and a positive quantity")
				.asRuntimeException());
			return;
		}
		Map<String, Integer> wanted = new TreeMap<>();
		request.getLinesList().forEach(l -> wanted.merge(l.getSku(), l.getQuantity(), Integer::sum));
		Map<String, Integer> available = this.db
			.sql("SELECT sku, on_hand - reserved FROM products WHERE sku = ANY(?)")
			.param(wanted.keySet().toArray(String[]::new))
			.query((rs, n) -> Map.entry(rs.getString(1), rs.getInt(2)))
			.list()
			.stream()
			.collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));

		CheckAvailabilityResponse.Builder out = CheckAvailabilityResponse.newBuilder().setAllAvailable(true);
		wanted.forEach((sku, qty) -> {
			Integer have = available.get(sku);
			boolean sufficient = have != null && have >= qty;
			out.addLines(LineAvailability.newBuilder()
				.setSku(sku)
				.setKnown(have != null)
				.setAvailable(have == null ? 0 : have)
				.setSufficient(sufficient));
			if (!sufficient) {
				out.setAllAvailable(false);
			}
		});
		response.onNext(out.build());
		response.onCompleted();
	}

}
