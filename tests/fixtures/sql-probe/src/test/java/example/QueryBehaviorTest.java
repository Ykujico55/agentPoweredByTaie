package example;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.AfterClass;
import org.junit.Before;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class QueryBehaviorTest {
    private Connection connection;
    private Statement realStatement;
    private Statement statement;
    private final List<String> queries = new ArrayList<>();
    private static final List<String> observations = new ArrayList<>();
    private static final String PAYLOAD = "alice' OR '1'='1";
    private static final String FIXED_QUERY = "SELECT id FROM accounts WHERE name = 'alice'";

    @Before
    public void prepare() throws SQLException {
        connection = DriverManager.getConnection("jdbc:h2:mem:probe");
        realStatement = connection.createStatement();
        realStatement.execute("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name VARCHAR(40))");
        realStatement.execute("INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob')");
        statement = (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(),
                new Class<?>[] { Statement.class }, (proxy, method, arguments) -> {
                    if (method.getName().equals("executeQuery")) queries.add((String) arguments[0]);
                    try { return method.invoke(realStatement, arguments); }
                    catch (InvocationTargetException error) { throw error.getCause(); }
                });
    }

    @After
    public void close() throws SQLException {
        if (realStatement != null) realStatement.close();
        if (connection != null) connection.close();
    }

    @AfterClass
    public static void saveObservations() throws IOException {
        Files.createDirectories(Path.of("target"));
        Files.writeString(Path.of("target", "sql-observations.json"),
                "{\"schemaVersion\":1,\"database\":\"H2 2.3.232\",\"observations\":["
                        + String.join(",", observations) + "]}\n");
    }

    private static String json(String value) {
        return value == null ? "null" : "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private List<Integer> observe(String caseId, String input, Boolean flag, ResultSet result) throws SQLException {
        List<Integer> ids = null;
        if (result != null) {
            try (result) {
                ids = new ArrayList<>();
                while (result.next()) ids.add(result.getInt(1));
                ids.sort(Integer::compareTo);
            }
        }
        String sql = "[" + String.join(",", queries.stream().map(QueryBehaviorTest::json).toList()) + "]";
        observations.add("{\"caseId\":" + json(caseId) + ",\"input\":" + json(input)
                + ",\"flag\":" + flag + ",\"sql\":" + sql + ",\"rows\":" + ids + "}");
        return ids;
    }

    @Test
    public void caseAChangesQueryMeaning() throws SQLException {
        assertEquals(List.of(1), observe("A", "alice", null, CaseA.execute(statement, "alice")));
        assertEquals(List.of(FIXED_QUERY), queries);
        queries.clear();
        assertEquals(List.of(1, 2), observe("A", PAYLOAD, null, CaseA.execute(statement, PAYLOAD)));
        assertEquals(List.of("SELECT id FROM accounts WHERE name = 'alice' OR '1'='1'"), queries);
    }

    @Test
    public void caseBSelectsTheSecondInvocation() throws SQLException {
        assertEquals(List.of(1), observe("B", PAYLOAD, null, CaseB.execute(statement, PAYLOAD)));
        assertEquals(List.of(FIXED_QUERY), queries);
        queries.clear();
        assertEquals(List.of(1), observe("B", null, null, CaseB.execute(statement, null)));
        assertEquals(List.of(FIXED_QUERY), queries);
    }

    @Test
    public void caseCUsesMutuallyExclusiveBranches() throws SQLException {
        String input = "SELECT id FROM accounts";
        assertEquals(List.of(1), observe("C", input, false, CaseC.execute(statement, input, false)));
        assertEquals(List.of(FIXED_QUERY), queries);
        queries.clear();
        assertNull(observe("C", input, true, CaseC.execute(statement, input, true)));
        assertEquals(List.of(), queries);
    }

    @Test
    public void caseDUsesAFixedQuery() throws SQLException {
        assertEquals(List.of(1), observe("D", PAYLOAD, null, CaseD.execute(statement, PAYLOAD)));
        assertEquals(List.of(FIXED_QUERY), queries);
        queries.clear();
        assertEquals(List.of(1), observe("D", "alice", null, CaseD.execute(statement, "alice")));
        assertEquals(List.of(FIXED_QUERY), queries);
    }

    @Test
    public void caseERetainsTheFirstInvocation() throws SQLException {
        assertEquals(List.of(1), observe("E", FIXED_QUERY, null, CaseE.execute(statement, FIXED_QUERY)));
        assertEquals(List.of(FIXED_QUERY), queries);
        queries.clear();
        String input = "SELECT id FROM accounts";
        assertEquals(List.of(1, 2), observe("E", input, null, CaseE.execute(statement, input)));
        assertEquals(List.of(input), queries);
    }

    @Test
    public void caseFSelectsTheSecondInvocation() throws SQLException {
        assertEquals(List.of(1), observe("F", FIXED_QUERY, null, CaseF.execute(statement, FIXED_QUERY)));
        assertEquals(List.of(FIXED_QUERY), queries);
        queries.clear();
        String input = "SELECT id FROM accounts";
        assertEquals(List.of(1), observe("F", input, null, CaseF.execute(statement, input)));
        assertEquals(List.of(FIXED_QUERY), queries);
    }
}
