const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Firebase Admin using environment variables
admin.initializeApp({
  credential: admin.credential.cert({
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID || "opportunity-9d3bf",
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    universe_domain: "googleapis.com"
  }),
  databaseURL: "https://opportunity-9d3bf-default-rtdb.firebaseio.com"
});

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware - Updated CORS for production
const corsOptions = {
  origin: [
    'http://localhost:3000', // Development
    'https://smart-fit-ar.vercel.app', // Your Vercel frontend
    'https://smart-fit-ar-git-main-paulos-projects-3f9d8f2a.vercel.app', // Vercel preview
    'https://smart-fit-ar-*.vercel.app' // All Vercel preview deployments
  ],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// ==================== EMPLOYEE BATCH GENERATION ====================

/**
 * Generate batch employee accounts with Firebase Auth
 */
app.post('/api/generate-employees', async (req, res) => {
  try {
    const { shopId, employeeData, shopOwnerId } = req.body; // Removed count

    // Validate request
    if (!shopId || !shopOwnerId) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: shopId, shopOwnerId"
      });
    }

    // Verify shop owner exists and has permission
    const shopOwnerRef = admin.database().ref(`smartfit_AR_Database/shop/${shopOwnerId}`);
    const shopOwnerSnapshot = await shopOwnerRef.once('value');
    
    if (!shopOwnerSnapshot.exists()) {
      return res.status(403).json({
        success: false,
        error: "Shop owner not found or unauthorized"
      });
    }

    const employees = [];
    const errors = [];

    // Get the domain from employeeData or use default
    const domain = employeeData.domain || 'yourcompany.com';
    
    // Get count from employeeData or use default
    const count = employeeData.count || 1; // Default to 1 if not specified

    if (count > 50) {
      return res.status(400).json({
        success: false,
        error: "Cannot generate more than 50 employees at once"
      });
    }

    for (let i = 0; i < count; i++) {
      try {
        const employeeNumber = i + 1;
        const username = `employee${employeeNumber}`;
        const email = `${username}@${domain}`;
        const password = generatePassword();

        // Create user in Firebase Authentication
        const userRecord = await admin.auth().createUser({
          email: email,
          password: password,
          emailVerified: true,
          disabled: false
        });

        // Create employee record in Realtime Database
        const employeeRecord = {
          ...employeeData,
          id: userRecord.uid,
          shopId: shopId,
          shopOwnerId: shopOwnerId,
          email: email,
          temporaryPassword: password,
          employeeId: `EMP${shopId.slice(-4).toUpperCase()}${employeeNumber.toString().padStart(3, '0')}`,
          role: employeeData.role || 'employee',
          status: 'active',
          permissions: employeeData.permissions || [
            'view_products',
            'manage_orders',
            'view_inventory'
          ],
          dateCreated: new Date().toISOString(),
          createdBy: shopOwnerId,
          lastUpdated: new Date().toISOString(),
          isBatchGenerated: true
        };

        // Save to database
        await admin.database().ref(`smartfit_AR_Database/employees/${userRecord.uid}`).set(employeeRecord);

        // Add to shop's employees list
        await admin.database().ref(`smartfit_AR_Database/shop_employees/${shopId}/${userRecord.uid}`).set({
          employeeId: userRecord.uid,
          email: email,
          status: 'active',
          dateAdded: new Date().toISOString()
        });

        employees.push({
          uid: userRecord.uid,
          employeeId: employeeRecord.employeeId,
          email: email,
          temporaryPassword: password,
          status: 'created'
        });

      } catch (error) {
        errors.push({
          employeeNumber: i + 1,
          error: error.message
        });
        console.error(`Failed to create employee ${i + 1}:`, error);
      }
    }

    // Log the batch creation
    await admin.database().ref(`smartfit_AR_Database/employee_batch_logs/${shopId}`).push({
      timestamp: new Date().toISOString(),
      shopOwnerId: shopOwnerId,
      countRequested: count,
      countCreated: employees.length,
      countFailed: errors.length,
      employees: employees.map(emp => ({ email: emp.email, employeeId: emp.employeeId })),
      errors: errors
    });

    res.json({
      success: true,
      message: `Successfully created ${employees.length} out of ${count} employee accounts`,
      employees: employees,
      errors: errors,
      summary: {
        totalRequested: count,
        successfullyCreated: employees.length,
        failed: errors.length
      }
    });

  } catch (error) {
    console.error('Batch employee generation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== EMPLOYEE MANAGEMENT ====================

/**
 * Get all employees for a shop
 */
app.get('/api/shop/:shopId/employees', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { shopOwnerId } = req.query; // Verify ownership

    if (!shopOwnerId) {
      return res.status(400).json({
        success: false,
        error: "shopOwnerId query parameter is required"
      });
    }

    // Verify shop owner has access to this shop
    const shopRef = admin.database().ref(`smartfit_AR_Database/shop/${shopOwnerId}`);
    const shopSnapshot = await shopRef.once('value');
    
    if (!shopSnapshot.exists()) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized access to shop employees"
      });
    }

    const employeesRef = admin.database().ref(`smartfit_AR_Database/employees`);
    const employeesSnapshot = await employeesRef.orderByChild('shopId').equalTo(shopId).once('value');

    if (!employeesSnapshot.exists()) {
      return res.json({
        success: true,
        data: []
      });
    }

    const employees = [];
    employeesSnapshot.forEach((childSnapshot) => {
      const employee = childSnapshot.val();
      // Remove sensitive data
      const { temporaryPassword, ...safeEmployeeData } = employee;
      employees.push(safeEmployeeData);
    });

    res.json({
      success: true,
      data: employees
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Update employee status (activate/deactivate)
 */
app.patch('/api/employees/:employeeId/status', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { status, shopOwnerId } = req.body;

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status. Use: active, inactive, or suspended"
      });
    }

    // Verify employee exists and belongs to shop owner
    const employeeRef = admin.database().ref(`smartfit_AR_Database/employees/${employeeId}`);
    const employeeSnapshot = await employeeRef.once('value');

    if (!employeeSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        error: "Employee not found"
      });
    }

    const employee = employeeSnapshot.val();
    if (employee.shopOwnerId !== shopOwnerId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized to modify this employee"
      });
    }

    // Update status in database
    await employeeRef.update({
      status: status,
      lastUpdated: new Date().toISOString(),
      statusUpdatedBy: shopOwnerId
    });

    // Update status in Firebase Auth if needed
    if (status === 'suspended' || status === 'inactive') {
      await admin.auth().updateUser(employeeId, {
        disabled: true
      });
    } else {
      await admin.auth().updateUser(employeeId, {
        disabled: false
      });
    }

    res.json({
      success: true,
      message: `Employee status updated to ${status}`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Reset employee password
 */
app.post('/api/employees/:employeeId/reset-password', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { shopOwnerId } = req.body;

    // Verify authorization
    const employeeRef = admin.database().ref(`smartfit_AR_Database/employees/${employeeId}`);
    const employeeSnapshot = await employeeRef.once('value');

    if (!employeeSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        error: "Employee not found"
      });
    }

    const employee = employeeSnapshot.val();
    if (employee.shopOwnerId !== shopOwnerId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized to reset password for this employee"
      });
    }

    const newPassword = generatePassword();
    
    // Update password in Firebase Auth
    await admin.auth().updateUser(employeeId, {
      password: newPassword
    });

    // Update temporary password in database
    await employeeRef.update({
      temporaryPassword: newPassword,
      passwordResetAt: new Date().toISOString(),
      passwordResetBy: shopOwnerId,
      lastUpdated: new Date().toISOString()
    });

    res.json({
      success: true,
      message: "Password reset successfully",
      newPassword: newPassword // Send back for distribution
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Delete employee account
 */
app.delete('/api/employees/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { shopOwnerId } = req.body;

    // Verify authorization
    const employeeRef = admin.database().ref(`smartfit_AR_Database/employees/${employeeId}`);
    const employeeSnapshot = await employeeRef.once('value');

    if (!employeeSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        error: "Employee not found"
      });
    }

    const employee = employeeSnapshot.val();
    if (employee.shopOwnerId !== shopOwnerId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized to delete this employee"
      });
    }

    // Delete from Firebase Auth
    await admin.auth().deleteUser(employeeId);

    // Delete from database
    await employeeRef.remove();

    // Remove from shop employees list
    await admin.database().ref(`smartfit_AR_Database/shop_employees/${employee.shopId}/${employeeId}`).remove();

    res.json({
      success: true,
      message: "Employee account deleted successfully"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== UTILITY FUNCTIONS ====================

function generatePassword(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Employee Management API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: 'SmartFit Employee Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      generateEmployees: '/api/generate-employees',
      getEmployees: '/api/shop/:shopId/employees',
      updateStatus: '/api/employees/:employeeId/status',
      resetPassword: '/api/employees/:employeeId/reset-password',
      deleteEmployee: '/api/employees/:employeeId'
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : error.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.listen(PORT, () => {
  console.log(`Employee Management API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});